# Tenant Transactional Reset — Investigation Report & Remediation Plan

## A. Immediate root cause (proven, not guessed)

Captured from the Postgres logs (three identical occurrences, matching the failing run):

```text
SQLSTATE : 42702  column reference "org_id" is ambiguous
DETAIL   : It could refer to either a PL/pgSQL variable or a table column.
CONTEXT  : PL/pgSQL function reset_module__pos(uuid) line 87 at SQL statement
           PL/pgSQL function reset_organization_data(uuid,text) line 16 at assignment
```

`reset_organization_data(org_id uuid, confirmation_token text)` calls the module
functions in order; the second call (`reset_module__pos`) fails. The offending
statements are the three that touch tables whose tenant column is literally named
`org_id` (not `organization_id`):

```sql
DELETE FROM accounting_events
 WHERE org_id = reset_module__pos.org_id AND producer = 'pos';

DELETE FROM business_event_outbox
 WHERE org_id = reset_module__pos.org_id AND source_doc_type IN (...);

DELETE FROM business_event_outbox_dead
 WHERE org_id = reset_module__pos.org_id AND source_doc_type IN (...);
```

The right-hand side is correctly qualified with the function name. The **left-hand
side is bare `org_id`**, which PL/pgSQL cannot resolve: it matches both the
function parameter `org_id` and the table column `org_id`. Default
`plpgsql.variable_conflict = error`, so it raises 42702 at first execution of that
statement — no earlier statement in the module is affected because every other
reset table uses `organization_id`, which never collides.

This is a latent bug that only surfaces once those three statements are reached;
it is not caused by any expense/procurement hardening migration. The tables with a
literal `org_id` column in this schema are: `accounting_events`,
`business_event_outbox`, `business_event_outbox_dead`, `commercial_audit_logs`,
`hardware_command_queue`, `hardware_exec_log`, `label_templates`,
`media_profiles`, `org_health`, `reprint_requests`. A full scan of every
`public` function for the pattern `WHERE|AND|OR org_id =` shows only
`reset_module__pos` carries this collision inside the reset subsystem.

## B. Current reset architecture (as read from the live database)

```text
UI OrgDataResetTool
  → edge function clear-org-data  (mode: wipe_all | categories | delete_org)
      → creates a reset-run row, then
      → RPC reset_organization_data(org_id, 'RESET-<org_id>')   [user JWT]
          _assert_reset_permission(org_id)      -- platform admin OR owner/admin in user_roles
          confirmation token check              -- 22023 on mismatch
          set_config('app.reset_in_progress', org_id, true)   -- txn-local teardown GUC
          reset_module__unlink_audit_refs → pos → warehouse → inventory →
          fixed_assets → vendor_returns → ancillaries → transactions_ledger →
          banking → sales → purchases → hr → payroll → finance → sequences
          UPDATE accounts SET current_balance = 0
          residual coverage check over ~50 transactional tables
          returns { success, counts, residual, coverage_check }
      → storage sweep (receipts, document-pdfs), then finishRun(...)
```

Atomicity: the whole thing is **one RPC = one transaction**, so the 42702 aborted
everything — nothing was deleted, no partial wipe. The only rows that survive the
failure are the edge function's own run record (written with the admin client,
outside that transaction), which is correctly marked failed with stage
`reset_organization_data`. Retry is therefore safe.

Teardown context: every immutability/append-only trigger honours
`app.reset_in_progress` (already covered by `supabase/tests/teardown_context_bypass_test.sql`),
and module functions refuse to run outside that context.

## C/D. Transactional vs preserved boundary

The boundary is already encoded in the module functions and the residual check:
transactional = POS documents/shifts/statements, WMS execution, inventory movement
and stock position, fixed-asset depreciation, vendor returns/credit notes,
approval requests + history + rule logs, customer statements, eTIMS logs, banking
transactions/statements/reconciliations, sales documents, purchase documents and
expenses, HR/attendance/leave, payroll runs/payslips, journal entries and lines,
numbering sequences. Preserved = organizations, businesses, branches, users and
roles, chart of accounts (balances zeroed, rows kept), products, contacts,
warehouses, tax/currency/payment-method configuration, governance mode and
approval **rules**, templates and settings. This plan does not widen or narrow
that classification; it fixes the defect and closes the coverage gaps named below.

## E. Coverage gap found while auditing (not the crash, but real)

`accounting_events`, `business_event_outbox` and `business_event_outbox_dead` are
purged **only for POS producers/doc types**. Sales, purchase, WMS, payroll and
purchase-return producers emit into the same tables, so after a successful wipe
the outbox dispatcher would keep retrying messages for deleted documents and the
Accounting Events workspace would show events for rows that no longer exist.
Neither table is in the residual coverage check, so `coverage_check: passed`
would be reported anyway.

## F. Regression analysis

No evidence that any recent hardening migration caused this. The failing
statements are internal to `reset_module__pos`, reference no new constraint, and
fail on name resolution before touching data. Claim: **not a hardening
regression** — a pre-existing ambiguity in the POS module that only trips when
the POS stage is reached.

## G. BackgroundSyncManager 401 — independent

`src/services/offline/BackgroundSyncManager.ts::checkRealConnectivity` sends
`HEAD $SUPABASE_URL/rest/v1/` with only the `apikey` header. PostgREST's root
requires an `Authorization` bearer as well, so it answers 401; the code already
treats 401 as "reachable" and returns online. Functionally harmless, unrelated to
the reset, but it floods the console on every poll. Fix separately by probing an
endpoint that answers 200 (`/auth/v1/health`) or by attaching the anon bearer.

## N. Verdict

**NO** — in its current state the reset cannot complete at all (aborts at the POS
stage), and even after the ambiguity fix it would leave non-POS accounting events
and outbox messages behind. Both are addressed below.

---

## Remediation

### 1. Fix the ambiguity (migration)

`CREATE OR REPLACE FUNCTION public.reset_module__pos(org_id uuid)` with:

- every predicate on an `org_id`-columned table written as
  `<table>.org_id = reset_module__pos.org_id` (alias the DELETE target where
  needed), removing all bare `org_id` references;
- no other behavioural change to the POS deletion order.

### 2. Close the event/outbox coverage gap (same migration)

- Add a new `reset_module__events(org_id uuid)` that deletes **all**
  `accounting_events`, `business_event_outbox` and `business_event_outbox_dead`
  rows for the tenant (these are projections of transactional documents, never
  configuration), fully qualified, and guarded by the teardown-context check like
  its sibling modules.
- Call it from `reset_organization_data` **after** every document module, and add
  the three tables to the residual coverage check so a future miss fails loudly
  instead of reporting `passed`.
- Keep the POS-scoped deletes in `reset_module__pos` so per-category resets stay
  correct.

### 3. Preserve every existing safeguard

No change to `_assert_reset_permission`, the confirmation token, SECURITY DEFINER
+ `search_path = public`, the teardown GUC, transaction boundaries, or any
immutability trigger.

### 4. Regression tests

Add `supabase/tests/reset_pos_org_id_unambiguous_test.sql`:

- assert `reset_module__pos` contains no bare `org_id` predicate (regex on
  `pg_get_functiondef`, the same ratchet style used by the existing teardown
  tests);
- assert `reset_organization_data` calls `reset_module__events`;
- assert the residual coverage query mentions `accounting_events`,
  `business_event_outbox`, `business_event_outbox_dead`.

Extend `supabase/tests/teardown_context_bypass_test.sql` expectations only if the
new module introduces a guard interaction.

### 5. Verification after the migration

Run the wipe from the UI on the current tenant and confirm:
`coverage_check: passed`, `residual: {}`, and follow-up counts of `0` for
`accounting_events` / `business_event_outbox` / `business_event_outbox_dead`,
while accounts, products, contacts, warehouses, approval **rules** and governance
mode rows remain. Confirm a second consecutive wipe also succeeds (idempotence).

### 6. BackgroundSync 401 (separate, frontend only)

Change the connectivity probe to `GET $SUPABASE_URL/auth/v1/health` with the
`apikey` header (returns 200), keeping the existing "401/403 still means online"
tolerance as a fallback. No change to sync scheduling or auth.

## Technical notes

- Files touched: one Supabase migration (POS + orchestrator + new events module),
  `supabase/tests/reset_pos_org_id_unambiguous_test.sql` (new),
  `src/services/offline/BackgroundSyncManager.ts` (probe endpoint only).
- Full-tenant A/B isolation, atomicity and repeatability testing is described in
  step 5; deeper multi-tenant fixture testing would need a second seeded tenant,
  which does not exist in this project today — say the word and I will add a
  pgTAP fixture tenant for it.
