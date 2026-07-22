# Payroll Legal Orders — Phase 0 Verified Diagnosis (2026-07-22)

Read-only investigation. No code changed in this phase.

## The 403 (root cause, not symptom)

`public.garnishment_transition(...)` (migration `20260630171133`) gates every
FSM transition on:

```sql
IF NOT (public.has_role(v_actor, 'admin') OR public.has_role(v_actor, 'manager'))
  THEN RAISE 'GARNISHMENT_FORBIDDEN';
```

The RLS write policy on `public.employee_garnishments` (`employee_garnishments_hr_write`)
grants INSERT/UPDATE/DELETE to `admin OR owner OR accountant`. **The two
role sets do not intersect for `owner` and `accountant`.** A tenant `owner`
can create a draft order, see it in the UI, and then hit `GARNISHMENT_FORBIDDEN`
when clicking Activate. `manager` — which the RPC accepts — is not even one of
the roles listed in the write policy. This is a straight authz-model mismatch,
not a missing organization context and not an RLS bug.

Neither `owner`, `accountant`, nor `super_admin` appears in the RPC's role gate.
Any tenant not administering under `admin` is locked out of activation today.

## Framework we already have (verified in DB)

| Building block | Present? |
|---|---|
| `governance_assert_not_self(...)` | yes |
| `governance_assert_not_subject(...)` | yes |
| `self_action_policy` table | yes |
| `approval_workflows` table | yes (0 rows for `entity_type='garnishment_order'` or `'legal_order'`) |
| `garnishment_ledger` view | yes |
| `localization_pack_garnishment_kinds` table | yes |
| `localization_pack_garnishment_policies` table | yes |
| `garnishment_kind_defaults` (13 rows) | yes |
| `has_permission(...)` function | **no** — plan Phase 1 must NOT depend on this; use `has_role` + `self_action_policy` |

## Domain state (verified from `information_schema`)

`employee_garnishments` already carries: `status`, `status_changed_at/by`,
`status_reason`, `total_accrued`, `aggregate_cap_exempt`, `payee_contact_id`,
`payee_payment_method_id`, `payee_unmapped`, `employment_id`,
`minimum_take_home_amount`, `document_url/filename`. The FSM extensions from
migration `20260630171133` are all live.

`issuing_authority` is `text` (unstructured) — Phase 3 target.

`case_reference` is `text` (unstructured) — Phase 3 target.

## Localization pack — reality check

Both `localization_pack_garnishment_kinds` and `..._policies` exist, so packs
already publish more than labels. What they do **not** publish today (schema
inspection required next):

- structured `protected_earnings_rule`
- structured `remittance_schedule_ref`
- `evidence_requirements`
- `completion_rule`
- `reporting_binding_ref`

These are the missing legal-behaviour fields Phase 2 must add. Whether
`install-localization-pack` copies pack rows into
`garnishment_kind_defaults` at install time is still unverified — Phase 2
starts by tracing that edge function.

## Consequence for the plan

- **Phase 1 revision.** Replace the flat `admin OR manager` gate with:
  1. RLS-aligned role check (`admin OR owner OR accountant OR super_admin`
     for HR paths; expand to include `manager` for `suspend`/`resume` only if
     the user confirms managers should have runtime control).
  2. `governance_assert_not_subject(auth.uid(), employee_id)` — the actor
     must not be the affected employee.
  3. Per-org `self_action_policy` row (`action_key='payroll.legal_order.activate'`,
     default `require_approval`).
  4. When an `approval_workflow` for `entity_type='legal_order'` exists AND
     `self_action_policy.mode='require_approval'`, an `approved` `approval_request`
     for the target order is required for `activate` / `release` /
     `terminate_unsatisfied`.
  5. Every refusal raises the existing `GOV_*` HINTs so the UI's
     `parseGovernanceError` already handles the messaging.
- **No new `has_permission` function.** Reuse existing `has_role` + governance
  framework; do not invent parallel authz.
- Phases 2–6 unchanged.

## Immediate next step (needs user input before Phase 1)

Three questions posted to the user; Phase 1 migration is blocked on their
answers so we do not solidify the wrong authz model.
