
## What's happening

Approving a loan calls `employee_loan_lifecycle_approve(uuid)`. That function's body contains:

```sql
PERFORM public.governance_assert_not_self('loan.approve','employee_loan',_loan_id, r.created_by);
PERFORM public.governance_assert_not_subject('loan.approve_self_benefit','employee_loan',_loan_id);
```

Both use an old 4-arg / 3-arg call shape. The functions that actually exist in the database today are:

```
governance_assert_not_self(p_actor uuid, p_subject uuid, p_action text, p_org uuid, p_entity_type text, p_entity_id uuid)
governance_assert_not_subject(p_actor uuid, p_subject uuid, p_action text, p_org uuid, p_entity_type text, p_entity_id uuid)
```

So Postgres raises `42883 undefined_function`, which PostgREST surfaces as a **404** with the "does not exist" message. Nothing to do with governance mode being Solo — the call never reaches the evaluator.

Confirmed by inspection, the same stale call shape exists in four more loan RPCs, all currently dead on arrival:

- `employee_loan_lifecycle_approve`
- `employee_loan_authorize_disbursement`
- `employee_loan_record_manual_repayment`
- `employee_loan_write_off`
- `employee_loan_restructure`

Every other caller in the database (the ~20 `sod_*` / `guard_*` triggers) already uses the correct 6-arg shape, so this is an isolated pocket of drift in the loans module.

## Fix

One migration that recreates the five functions with correct governance calls. Bodies are otherwise unchanged.

For each, the call becomes:

```sql
PERFORM public.governance_assert_not_self(
  auth.uid(),                                    -- actor: whoever is approving
  COALESCE(r.requested_by, r.created_by),        -- subject: who raised the loan
  'loan.approve',                                -- registered action key
  r.organization_id,
  'employee_loan',
  _loan_id
);
```

with the appropriate action key per function (`employee_loan.authorize_disbursement`, `employee_loan.record_manual_repayment`, `employee_loan.write_off`, `employee_loan.restructure`). `employee_loans` carries `organization_id`, `created_by`, `requested_by`, `approved_by`, so all arguments resolve from the already-locked row.

`governance_assert_not_subject` in the approve path gets the same 6-arg treatment — it resolves the loan's beneficiary employee internally, so it stays a separate call guarding the "approver is the loan beneficiary" case.

## Expected behaviour after the fix

With the org in **Solo** mode and one active member, `governance_assert_not_self` auto-allows and writes a `sod.self_action_auto_allowed` audit event, so an owner approving a portal user's loan succeeds. In `standard`/`strict` the normal tiering applies, and the error surfaces as `42501` / `GOV_SELF_ACTION`, which the UI already renders via `parseGovernanceError` — a readable "Self-approval blocked" toast instead of a 404.

Note the `guard_employee_loan_self_approval` BEFORE UPDATE trigger on `employee_loans` already calls the correct 6-arg helper for `loan.approve`, so the in-RPC call is belt-and-braces on the same action key; both paths are consistent once the signature is fixed.

## Verification

1. Re-run the query that enumerates `governance_assert_not_self(` call sites and confirm zero remaining legacy-shape calls.
2. Approve the pending salary-advance request from the admin side and confirm a 200 plus `status = 'approved'`.
3. Check `audit_logs` for the `sod.self_action_auto_allowed` row proving the evaluator ran rather than being skipped.

## Out of scope

Phase 4.3 (Inventory `create_stock_adjustment` → `approval_route` migration and retiring `approval_rule_logs`) stays queued; this is a targeted signature fix so loan approvals work now.
