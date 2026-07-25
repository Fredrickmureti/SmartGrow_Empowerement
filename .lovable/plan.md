## What's happening

Three independent problems, all traceable:

### 1. `legal_order_build_remittance_batch` → 404 "user_has_organization_access does not exist"

The Phase 7 remittance batch RPCs (ADR-0096) were authored calling `public.user_has_organization_access(...)`, but the canonical helper in this project is `public.user_belongs_to_org(org_id uuid)`. Confirmed in:

- `supabase/migrations/20260724140949_…sql` — `legal_order_build_remittance_batch`, `legal_order_generate_remittance_bank_file`, `legal_order_settle_remittance_batch`, `legal_order_cancel_remittance_batch`
- `supabase/migrations/20260724143004_…sql` — additional batch RPC
- `supabase/migrations/20260724143847_…sql` — `legal_order_recipient_statement`

Because the guard call fails to resolve, PostgREST reports the entire function as "not found" (404).

### 2. "Run statement" red text — same root cause

`LegalOrdersReports.tsx` calls `legal_order_recipient_statement(org, recipient, from, to)` (the 4-arg Phase R7 RPC). That RPC also references `user_has_organization_access(uuid)` and blows up on invocation. The Recipients page's `legal_recipient_statement(recipient, from, to)` (3-arg, older) works fine — that's why the network log shows it returning data — but the Reports tab uses the 4-arg wrapper which is broken.

### 3. April payroll run didn't include the 7,000 child support

Not a compute-payroll bug. The order row itself is in the wrong state:

```
id:            0dfb6e04-…-370f7f
status:        satisfied        ← compute-payroll only loads status='active'
total_owed:    NULL
total_paid:    0.00
total_accrued: 63,000
```

Only one 7,000 accrual exists in `garnishment_ledger`, yet `total_accrued=63,000` and `status=satisfied`. Something transitioned it to a terminal state prematurely (likely `legal_order_auto_satisfy` or a manual FSM call operating against the NULL `total_owed` — `Σ remittance ≥ total_owed` is trivially true when `total_owed` is NULL/0). Compute-payroll's filter (`.eq("status","active")`) is correct; the data is wrong.

## Fix plan

### Migration — repoint guards to the real helper

Rewrite (CREATE OR REPLACE, same signatures) the following RPCs to call `public.user_belongs_to_org(v_org_id)` instead of `public.user_has_organization_access(...)`, preserving all other logic:

- `legal_order_build_remittance_batch`
- `legal_order_generate_remittance_bank_file`
- `legal_order_settle_remittance_batch`
- `legal_order_cancel_remittance_batch`
- `legal_order_recipient_statement`
- Any other function in those three migrations still referencing the phantom name

### Migration — harden `legal_order_auto_satisfy`

Change the auto-satisfy predicate to require `total_owed IS NOT NULL AND total_owed > 0 AND Σ remittance ≥ total_owed`. This prevents any future order with a missing/zero cap from being auto-closed. (Leaves manual FSM transitions untouched — those already require evidence per Phase R6.)

### Data repair — this specific order

In the same migration, revert `0dfb6e04-…-370f7f` to `status='active'`, recompute `total_accrued` from `garnishment_ledger` (should be 7,000, not 63,000), and log a `garnishment_lifecycle_events` row with reason "R7 data repair — auto-satisfied against NULL total_owed". After the migration is approved, re-running April payroll for employee `5449cd48-…dfc9ce` will pick up the order.

### Optional follow-up (not in this pass)

The reason `total_owed` is NULL is that the order creation UI does not require it for kinds like child_support (which are open-ended). We should either (a) allow NULL total_owed and treat "satisfied" as manual-only, or (b) require a cap. That's an ADR-level product decision — flag it, don't decide it here.

## Verification

1. From the preview, click "Create batch" on Legal Orders → Batches. Expect a draft batch to appear, no 404.
2. On the Reports tab, run a recipient statement. Expect table rows, no red error.
3. Re-run April payroll for the affected employee. Expect a 7,000 child-support deduction line on the payslip and a matching `garnishment_ledger` accrual.

## Technical notes

- No schema changes, only function bodies and one data row.
- Two migrations (function fixes + data repair) or one combined — combined is fine since they're all guarded RPC/data touches.
- Frontend code needs no changes.
