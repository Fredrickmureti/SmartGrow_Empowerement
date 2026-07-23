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

---

## Addendum 2026-07-23 — Phase 6c (Step A) + approval auto-request (Step B)

**Step A — reporting rebind (partial, targeted).** `supabase/functions/post-payroll-gl/index.ts`
now hydrates garnishment payee metadata from the canonical `public.legal_orders`
view instead of the raw `employee_garnishments` table (fields: `payee_name`,
`payee_contact_id`, `kind_code`, `end_date`, `priority_class`, `calc_model`,
`authority_id`). FSM/write paths (`compute-payroll`, `post-garnishment-payment`,
`garnishment_transition`) intentionally remain on the physical table.
`payroll_return_runs` currently has no direct garnishment binding (grep clean),
so no return-extract rewrite was required in this pass; the invariant to
preserve is that any future statutory-return join must go through the view.

**Step B — approval-workflow auto-request.** `garnishment_transition` now, on
the `submit` action, inserts a `pending` row into `approval_requests` when an
active `approval_workflow` exists for `entity_type='legal_order'` in the org
and no open/approved request is already tied to the order. This closes the
"silent no-op" gap where the activation gate would happily let orders through
because nobody had ever created a request row. No behaviour change when no
workflow is configured (backward compatible with tenants that have not
adopted the workflow yet).

**Still pending (tracked in .lovable/plan.md):**

- Default `approval_workflow` seed on first `install_legal_order_kind_defaults`
  when the pack policy demands approval (Step B, second half).
- UI polish (Step C): `calc_model`-driven form, completion-rule gating,
  dashboard badges, `/hr/payroll/legal-orders` promoted to primary route.
- Phase 7 cleanup (Step D): drop free-text `issuing_authority`, rename
  `employee_garnishments` → `legal_orders_records` behind the view, remove
  the client-side engine shim.

---

## Addendum 2026-07-23 (session 3) — Milestone 1: statutory return legal-order line items

**Verification of prior work.** All four handoff checks from `.lovable/plan.md`
passed on the live DB (`legal_orders_records` table present, `employee_garnishments`
gone, `issuing_authority` column dropped, six RPCs present, 11 `legal_order.*`
outbox topics seeded). Repo grep confirmed no live `.from("employee_garnishments")`
or column selectors on the old names — only auto-generated FK constraint names
in `src/integrations/supabase/types.ts` (harmless; constraint identifiers were
not renamed).

**What landed in this session.**

- New DB function `public.legal_orders_return_extract(org, business, period_start,
  period_end, branch)` — `SECURITY INVOKER`, granted to `authenticated` +
  `service_role`. Reads `legal_order_remittance_lines` joined to the
  `public.legal_orders` view and `legal_order_authorities`; groups by order;
  orders by `priority_class` then authority name. Enforces the invariant that
  all reporting/return joins must go through the view.
- `supabase/functions/generate-statutory-return/index.ts` now attaches a
  `legal_orders` block to every generated `payroll_return_runs.payload`:
  flat `rows[]`, `groups[]` bucketed by authority, and a `totals` roll-up.
  Enrichment is opt-out via `template.body.include_legal_orders = false`;
  failures degrade gracefully (warn + omit the section) so return generation
  is never broken by garnishment-side issues.
- Lifecycle gate (`requireClosedPeriod`) is already invoked upstream — no
  duplicate guard added.

**Invariants preserved.**

- Writes still land on `legal_orders_records`; extract only reads the view.
- No new authz primitives; `SECURITY INVOKER` inherits caller RLS.
- Zero country-specific branches — priority and authority come from
  pack-seeded rows.
- Non-breaking for existing return templates; the new payload key is additive.

**Deferred to milestone 2 / 3 (unchanged from prior handoff).**

- Remittance batch payments UI (surface `legal_order_remittance_lines` in the
  payment batch builder, grouped by authority).
- Employee-facing document uploads (extend `LegalOrderDocuments.tsx` for ESS).
