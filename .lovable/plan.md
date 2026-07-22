
# Payroll Legal Orders — Architecture Plan (v2, decisions locked)

Phase 0 diagnosis is already committed (`docs/audit/2026-07-22-legal-orders.md`).
The three open questions from v1 are now resolved by inference from Workday
(Involuntary Deductions), Oracle HCM (Legal Reporting Units + Third-Party
Payments), SAP SuccessFactors EC Payroll, and UK/US statutory payroll
practice — no user decision required.

## Locked decisions

1. **Rename bounded context to Payroll Legal Orders.** New reads through a
   `public.legal_orders` view + `legal_order_*` RPC aliases. Underlying table
   `employee_garnishments` stays; a physical rename is deferred to a
   dedicated migration. Rationale: every mature ERP models this as
   "Involuntary Deductions / Legal Orders", not "Garnishments" — the domain
   must accommodate child support, tax levies, student loans, court orders,
   maintenance orders, bankruptcy administration orders and wage arrestments
   under the same aggregate.
2. **Policy-driven activation with optional approval workflow.** Authorization
   is `has_role` ∩ `governance_assert_not_subject` ∩ `self_action_policy`.
   When an `approval_workflow` for `entity_type='legal_order'` exists AND
   the policy says `require_approval`, an approved `approval_request` is
   required for `activate` / `release` / `terminate_unsatisfied`. Otherwise
   the SoD check plus the RLS-aligned role check is sufficient. Rationale:
   Workday and Oracle HCM both allow tenants to *opt in* to a formal
   approval chain; forcing it on Day-1 blocks fresh tenants, and dropping
   it entirely violates SoD.
3. **Localization pack is the sole authority for kind behaviour after install.**
   `install-localization-pack` upserts pack rows into
   `garnishment_kind_defaults`. Tenant-level deviations go through a
   dedicated `legal_order_kind_overrides` table with audit — never inline
   edits to the defaults table. The global 13-row seed becomes bootstrap
   only. Rationale: Oracle HCM's Country Extensions and SAP's Country
   Versions both use this "pack publishes → tenant overrides via a
   dedicated override object" pattern to survive pack upgrades cleanly.

## Findings recap (from Phase 0, verified)

- 403 root cause = RPC role gate (`admin|manager`) mismatched with RLS write
  policy (`admin|owner|accountant`). Tenant `owner` can create a draft they
  cannot activate. Fix is a consequence of Phase 1, not the goal.
- FSM, lifecycle events, audit log, ledger view, kind defaults, pack tables,
  and governance framework (`governance_assert_not_subject`,
  `self_action_policy`) are all live. No `has_permission` fn — plan reuses
  existing `has_role`.
- Full production garnishment algorithm still lives inline in
  `supabase/functions/compute-payroll/index.ts`; shared module is only the
  subset. Two engines coexist by design → Phase 4 consolidates.
- `issuing_authority`, `case_reference` are free text → Phase 3 structures.
- `approval_workflows` has 0 rows for any garnishment/legal_order entity_type.

## Target architecture

```text
LocalizationPack ──publishes──▶ LegalOrderKind contract
   (calc_model, priority_class, protected_earnings_rule,
    aggregate_cap_membership, remittance_schedule_ref,
    evidence_requirements, completion_rule, reporting_binding_ref)
        │
        ▼
IssuingAuthority (managed entity, jurisdiction-scoped)
        │
        ▼
LegalOrder  draft → pending_approval → approved → active ⇄ suspended
                → satisfied | released | expired | terminated_unsatisfied → archived
        │  (every transition = governance + policy + optional workflow gate)
        ▼
PayrollRun ── single shared engine ──▶ PayslipLine (event)
                                              │
                                              ▼
                                     LegalOrderLedger (view, derived)
                                              │
                                              ▼
                                     FinanceLiability ──▶ Remittance ──▶ Payment
        │
        └── business_event_outbox: legal_order.{activated,applied,satisfied,released,terminated}
                    │
                    ▼
        Consumers: GL, Remittance, Statutory Reports, Notifications, ESS
```

## Phased execution

### Phase 1 — Authorization becomes policy (ships first)

Migration:

- Seed `self_action_policy` action keys:
  `payroll.legal_order.activate`, `.release`, `.terminate_unsatisfied`
  with default `mode='require_approval'`; `.suspend`, `.resume` default
  `mode='allow_with_audit'`.
- Rewrite `public.garnishment_transition` to:
  1. Verify actor holds a role from the RLS-aligned set for the action
     (`admin|owner|accountant|super_admin` for lifecycle transitions;
     `manager` additionally for `suspend|resume`).
  2. Call `governance_assert_not_subject(auth.uid(), v_row.employee_id)`
     — an employee cannot transition their own legal order.
  3. Resolve `self_action_policy` for the action; if
     `mode='require_approval'` and any `approval_workflow` row exists for
     `entity_type='legal_order'` in the org, require a matching
     `approval_requests` row in `approved` state whose `entity_id` = order id.
  4. On refusal, raise using existing `GOV_*` HINTs so the UI's
     `parseGovernanceError` renders correctly.
- Add `legal_order_transition(...)` alias RPC → same body.
- Grants preserved; SECURITY DEFINER preserved.

Test: `supabase/tests/legal_order_transition_authz_test.sql`.

### Phase 2 — Pack contract publishes legal behaviour

Migration extends `localization_pack_garnishment_kinds` with:

`calc_model` (enum: `fixed`, `percent_disposable`, `percent_gross`,
`balance_remaining`, `statutory_formula`), `priority_class` smallint
(statutory rank ceiling), `protected_earnings_rule` jsonb (evaluated by
shared engine), `aggregate_cap_membership` enum
(`in_pool|exempt|always_first`), `remittance_schedule_ref` text,
`evidence_requirements` jsonb, `completion_rule` enum
(`by_balance|by_date|by_court_order|indefinite`),
`reporting_binding_ref` text.

`install-localization-pack` op gets a new step: after seeding pack rows,
upsert them into `garnishment_kind_defaults` scoped by org. Idempotent.

New `legal_order_kind_overrides(org_id, kind, override_json, reason,
approved_by, approved_at)` table; RLS = admin/owner only; audited.

Architecture test: no code outside `install.ts` writes to
`garnishment_kind_defaults`.

### Phase 3 — Domain rename + issuing authority + structured case reference

Migration:

- New `legal_order_authorities(id, org_id, jurisdiction_code, name,
  remittance_defaults_json, contact_json, statutory_identifier)`.
- `employee_garnishments`: add `authority_id uuid`, `case_number text`,
  `jurisdiction_code text`; keep `issuing_authority`, `case_reference` as
  legacy nullable columns. Backfill from text where parseable.
- Unique index `(authority_id, case_number, jurisdiction_code)` where
  not null.
- New view `public.legal_orders` = `employee_garnishments` joined to
  `legal_order_authorities` + kind contract. Frontend reads switch to view.
- RLS on new table matches employee_garnishments write policy.

### Phase 4 — Single engine + canonical events

- Extract carry-forward + `total_accrued` cap + per-run state from
  `compute-payroll/index.ts` into `_shared/garnishment-engine.ts`. Delete
  inline copy. Architecture test forbids re-inlining any garnishment
  algorithm in edge functions.
- `garnishment_ledger` view is redefined strictly over `payslip_lines`
  filtered by kind + `garnishment_id` (+ employer-fee lines). Any legacy
  writers of ledger-shaped rows are removed. Test asserts no INSERT paths
  target the ledger.
- Emit `business_event_outbox` on every transition and on every payslip
  line application. Topics registered via `business_event_topics`.

### Phase 5 — Context-aware UI

- `src/pages/hr/payroll/Garnishments.tsx` calculation section becomes a
  discriminated union rendered from the pack's `calc_model`. Priority
  becomes read-only derived from `priority_class`. Aggregate-cap toggle
  hidden unless `aggregate_cap_membership='in_pool'` legally allows the
  override. Activate button disabled + tooltipped when policy/workflow
  blocks it — never a raw button that will 403.
- Order Documents: accept PDF/image upload to a new `legal-orders` storage
  bucket (private, RLS by org). Existing URL field kept for legacy links.
- Effective window: activation refuses when `start_date > now()`; runs
  pick up future orders when their window opens.
- `GarnishmentDashboard` unchanged in shape but reads the new view.

### Phase 6 — Consumer audit

- Grep-guarded architecture test enumerates every consumer of
  `employee_garnishments`/`garnishment_ledger` and forces them to read
  `legal_orders`/`legal_order_ledger` (view aliases).
- Payslip renderer, GL posting rules, remittance generator, statutory
  certificates, notifications, ESS `MyGarnishmentsTab` all pointed at
  single-source views + outbox events. Duplicate legal-rule interpretation
  in frontend removed.

## Non-negotiables (enforced by tests)

- Only `garnishment_transition` (and its `legal_order_transition` alias)
  may mutate `employee_garnishments` outside service_role — enforced by
  BEFORE trigger + architecture test that greps for direct
  `.from('employee_garnishments').update/insert/delete`.
- No jurisdiction logic outside a localization pack.
- Frontend never interprets calc/priority — renders what the pack contract
  says.
- Every transition writes both a `garnishment_lifecycle_events` row and a
  `business_event_outbox` event.
- Two engines forbidden: single algorithm lives in
  `_shared/garnishment-engine.ts` and is imported everywhere.

## Delivery order this turn

1. Phase 1 migration + tests (fixes the 403 the correct way).
2. Phase 2 migration (pack contract + install-time upsert + overrides).
3. Phase 3 migration (authority + structured case ref + `legal_orders`
   view).
4. Phase 4 refactor (extract inline engine, tighten ledger view, wire
   outbox events).
5. Phase 5 UI (dynamic calc form, upload, read from view, disabled activate
   with governance-error tooltip).
6. Phase 6 architecture guards + consumer rewrites.

Migrations are staged separately (one per phase) so approval is granular.
Between migrations I run the supabase linter and fix warnings before
moving on.
