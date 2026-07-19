
# POS → Finance Posting Architecture — Handoff Plan

## What the audit found

The asynchronous pipeline is already in place and is architecturally sound.
The failure is not the RPC — it is **two competing accounting authorities**
plus a workspace mislabelled as a report.

```text
Sale ─┐
      ▼
pos_transactions ──► pos_gl_shadow_postings (read-only, per-sale, demoted)
      │
Shift close (pos_shifts.status='closed')
      │  trg _pos_bridge_close_to_stmt
      ▼
pos_statements (Z-report / session) ── trg _pos_stmt_enqueue_gl_post ─►
business_event_outbox('pos.statement.posting.requested')
      │
      ▼  outbox-dispatcher edge fn (service_role)
post_pos_statement_gl(statement_id)
      │  resolvers:
      │    resolve_pos_tender_gl_account(...)         -- tenders
      │    get_default_account_id('pos_revenue' | 'sales_revenue')
      │    get_default_account_id('pos_tax_payable' | 'tax_payable' | ...)
      │    get_default_account_id('tip_liability')
      ▼
post_journal_entry_atomic  ──►  journal_entries + pos_statement_gl_apply_log
      │
      ▼  trg _pos_stmt_stamp_register_period
pos_shifts.journal_entry_id / gl_posted_at   (stamped from statement)
```

The authoritative mapping registry is `default_account_settings` at the
**business** level, resolved by `resolve_pos_tender_gl_account` and
`get_default_account_id`. This matches the enterprise pattern (SAP Retail
"posting rules per till group", Oracle Xstore "tender/department accounting
rules", D365 Commerce "statement posting profile", LS Central "POS posting
setup", Odoo "closing session journal"). The register-period statement is
the accounting document — individual sales are subledger detail only.

### Where the drift is

1. **`get_pos_shift_gl_summary` (used by the current page)** aggregates by
   `products.sales_account_id`, `products.cogs_account_id`,
   `products.inventory_account_id`, and
   `pos_payment_methods.debit_account_id`. That is a **different, legacy
   mapping surface** and is not what `post_pos_statement_gl` actually reads.
   Every product/method whose per-row account is NULL renders as
   "Unmapped Sales Account" / "Unmapped COGS Account", even when the
   canonical `default_account_settings` mapping is present and the posting
   engine will succeed. This is the "already mapped elsewhere" complaint.

2. The report page mutates state via `post_pos_register_period_gl_now`.
   Reports must be read-only; operational repair belongs in an operational
   workspace.

3. Two shift-related outbox emitters (`shift.closed` from
   `pos_emit_register_period_event` and `pos.statement.posting.requested`
   from `_pos_stmt_enqueue_gl_post`) coexist. Only the second is drained by
   the dispatcher; the first is informational. Fine, but nothing surfaces
   dispatcher failures to the accountant today — retries live in
   `business_event_outbox` / `business_event_outbox_dead` and
   `pos_shift_close_errors`, none of which are visible from the current
   page.

4. Navigation is hardcoded under `Finance → Reports`; it is not gated on
   the POS app being installed or on a finance-operations permission.

The HTTP 400 is one of `check_violation` raises inside
`post_pos_statement_gl` (missing tender/revenue/tax account for **that
business**) surfacing as PostgREST 400. Root cause is unconfirmed until
the DB is inspected for this org's `default_account_settings` — Step 1
verifies it before any repair.

## Target architecture

- **Reports stay reports.** `/finance/reports/pos-shift-gl-integrity`
  becomes a strictly read-only integrity view (shift ↔ statement ↔ JE
  status, close errors, drift vs `v_pos_gl_posting_drift`). No buttons.
- **Operations become operations.** Create a new operational workspace:
  `/finance/operations/pos-posting-queue` (Finance app, "Operations" nav
  section). It is the single sanctioned place to inspect and retry POS
  statement postings.
- **One accounting authority.** The workspace's summary comes from a new
  `get_pos_statement_posting_preview(statement_id)` RPC that runs the same
  resolver chain as `post_pos_statement_gl` (dry-run: builds the same
  lines, reports each unresolved mapping by canonical key —
  `pos_revenue`, `pos_tax_payable`, tender `method_key`/`processor`).
  Product-level accounts are no longer consulted for POS statement
  posting — the ledger is settlement-centric.
- **Retry is safe and traceable.** Retry calls a new
  `retry_pos_statement_posting(statement_id, reason)` server function
  which (a) requires `finance.pos_posting.retry` permission, (b) re-enqueues
  the outbox event with a fresh idempotency suffix, and (c) writes an
  audit row. Direct `post_pos_statement_gl` execution stays `service_role`
  only — the UI never calls it.
- **App- and permission-aware navigation.** The Operations entry is
  registered via `FINANCE_NAV` with a predicate: POS app installed AND
  Finance app installed AND caller has `finance.pos_posting.view`.
- **Deprecate `get_pos_shift_gl_summary`.** Mark the RPC deprecated in a
  migration comment; the report page swaps to statement-centric read
  models. Product-level `sales_account_id`/`cogs_account_id` columns
  remain (they belong to the item/AR path, not POS session posting).

## Work breakdown

1. **Verify current state (no code change).**
   Query for the affected org:
   ```sql
   select setting_key, account_id from default_account_settings
   where business_id = :biz and setting_key in
     ('pos_revenue','sales_revenue','pos_tax_payable','tax_payable',
      'sales_tax_payable','tip_liability');
   select id, method_key, tender_kind from pos_payment_methods where business_id=:biz;
   select * from pos_statements where shift_id=:shift; -- posting_status/idempotency_key/close_kind
   select * from business_event_outbox where source_doc_id=:stmt;
   select * from business_event_outbox_dead where source_doc_id=:stmt;
   select * from pos_shift_close_errors where shift_id=:shift;
   ```
   Confirm whether missing `pos_revenue`/tender mapping or a dead outbox
   row is the true 400 cause. Record findings in a short audit note under
   `docs/audit/`.

2. **Migration — statement posting preview + retry.**
   - `get_pos_statement_posting_preview(uuid)` SECURITY DEFINER,
     STABLE. Same resolver chain as `post_pos_statement_gl`. Returns
     `{ statement, tenders[], revenue, tax, tip, unresolved[], balanced,
     total_debit, total_credit }`. `unresolved[]` items are canonical keys
     (`pos_revenue`, `pos_tax_payable`, tender `<method_key>/<processor>`),
     never account UUIDs.
   - `retry_pos_statement_posting(uuid, text)` SECURITY DEFINER, checks
     `has_role(auth.uid(),'admin' OR 'accountant')` (or a new
     `finance.pos_posting.retry` permission via existing permission
     groups), inserts a `pos.statement.posting.requested` outbox row with
     idempotency key `pos-stmt-post-<id>-retry-<epoch>`, appends an audit
     row in a new `pos_statement_posting_retries` table.
   - Comment `get_pos_shift_gl_summary` as deprecated; do not drop.
   - Include `GRANT`s per project convention.

3. **Operational workspace (`/finance/operations/pos-posting-queue`).**
   - New route + page. Lists `pos_statements` with
     `posting_status IN ('pending','failed')` plus recent posted ones,
     scoped org+business+branch (reuses `useFinanceScope`).
   - Row detail (drawer) shows: statement / register period / totals,
     preview lines from `get_pos_statement_posting_preview`, dispatcher
     attempts from `business_event_outbox` + `business_event_outbox_dead`
     (last error, last attempt, next retry), close errors from
     `pos_shift_close_errors`, previously posted JE link.
   - Actions: **Retry posting** (permission-gated, one-click, disabled
     until every `unresolved` is empty), **Open mapping** (deep link to
     Finance → Default Accounts pre-filtered to the missing key),
     **View shift** (deep link to POS).
   - Zero direct `post_pos_statement_gl` calls from the client.

4. **Report page becomes read-only.**
   - Strip "Post to accounting now" button and `postNow` mutation.
   - Replace product-derived warnings with statement-centric status from
     `pos_statements.posting_status` + `pos_statement_gl_apply_log` +
     `v_pos_gl_posting_drift`.
   - Add a "Open in Posting Queue" link for any not-posted / failed row.

5. **App-aware navigation.**
   - Extend `FINANCE_NAV` (`src/apps/finance/nav.ts`) with an
     `Operations` group containing `POS Posting Queue`, plus predicate
     `requires: { apps: ['pos','finance'], permission:
     'finance.pos_posting.view' }`.
   - `PlatformShell` already filters by predicate; verify and, if the
     hook doesn't yet support `apps`, extend `useInstalledApps` gate in
     the shell filter — do not hardcode in the page.

6. **Tests.**
   - `supabase/tests/pos_statement_posting_preview_test.sql` (pgTAP):
     preview resolves identical accounts to `post_pos_statement_gl`;
     `unresolved[]` populated when mapping missing; missing mapping does
     not raise from preview.
   - `supabase/tests/pos_statement_posting_retry_test.sql`: retry emits
     outbox row, is permission-gated, is idempotent per suffix.
   - `src/test/architecture/finance-reports-read-only.test.ts`: fails
     if any file under `src/pages/reports/` imports `supabase.rpc(...)`
     with a mutating name or `useMutation` (allow list of read-only RPCs).
   - `src/test/architecture/pos-posting-single-authority.test.ts`:
     grep-based test that `get_pos_shift_gl_summary` is not referenced
     by any new code and that the queue page uses only the preview RPC.

## Definition of done

- The POS→GL summary the accountant sees is produced by the same
  resolver that actually posts — mapping warnings can no longer disagree
  with posting outcomes.
- `/finance/reports/pos-shift-gl-integrity` is read-only; no mutation
  paths remain under `/reports`.
- `/finance/operations/pos-posting-queue` exists, is app- and
  permission-gated, shows dispatcher state + preview + unresolved
  mappings + retry, and is the only sanctioned manual retry surface.
- `post_pos_statement_gl` stays `service_role`; all UI retries flow
  through the outbox.
- pgTAP + architecture tests pin the invariants.
- No product-level `sales_account_id`/`cogs_account_id` reads remain on
  the POS session posting path.

## Out of scope (intentional)

- Per-sale (transaction-level) posting — remains demoted to shadow
  (`pos_gl_shadow_postings`); the statement is the accounting document.
- Redesigning `default_account_settings` UX — the workspace deep-links
  into the existing screen.
- Reworking `pos_emit_register_period_event` (informational topic).
