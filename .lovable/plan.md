# Payroll Legal Orders — Architecture Plan (v3, execution status)

Phase 0 diagnosis is committed at `docs/audit/2026-07-22-legal-orders.md`.
Architectural decisions were locked in v2 by inference from Workday
(Involuntary Deductions), Oracle HCM (Legal Reporting Units + Third-Party
Payments), SAP SuccessFactors EC Payroll, and UK/US statutory payroll
practice. No further user decision is required.

---

## Locked architectural decisions

1. **Rename bounded context to Payroll Legal Orders.** New reads through the
   `public.legal_orders` view + `legal_order_*` RPC aliases. Underlying table
   `employee_garnishments` stays; a physical rename is deferred to a dedicated
   migration once every consumer has migrated to the view.
2. **Policy-driven activation with optional approval workflow.** Authorization
   is `has_role` ∩ `governance_assert_not_subject` ∩ optional
   `approval_workflows`. When the org has configured a workflow with
   `entity_type='legal_order'`, an approved `approval_requests` row is
   required for `activate` / `release` / `terminate_unsatisfied`. Otherwise
   the SoD check plus the RLS-aligned role check is sufficient.
3. **Localization pack is the sole authority for kind behaviour after install.**
   `install-localization-pack` calls `install_legal_order_kind_defaults` to
   upsert pack rows into `garnishment_kind_defaults`. Tenant deviations go
   through `legal_order_kind_overrides` (audited). The global 13-row seed is
   bootstrap only.

---

## Roadmap status

| Phase | Title                                              | Status                    |
| ----- | -------------------------------------------------- | ------------------------- |
| 0     | Diagnosis                                          | Complete                  |
| 1     | Policy-driven authorization + FSM + outbox emit    | Complete & verified       |
| 2     | Pack legal-behaviour contract + install projection | Complete & verified       |
| 3     | Domain rename (view + authorities)                 | Complete & verified       |
| 4     | Engine consolidation + payment outbox emission     | Complete (tests pending)  |
| 5     | Context-aware UI (dynamic legal reflection)        | **Active — next up**      |
| 6     | Consumer rewire onto canonical `legal_order.*`     | Pending                   |

---

## Phase-by-phase detail

### Phase 1 — Authorization (DONE)

- `public.garnishment_transition` rewritten: RLS-aligned role set
  (admin/owner/accountant/super_admin; manager also for suspend/resume) +
  `governance_assert_not_subject` (SoD, actor ≠ subject employee) + optional
  approval-workflow gate for activate/release/terminate_unsatisfied when the
  org has an `approval_workflows` row for `entity_type='legal_order'`.
- Future-dated activation blocked (`start_date > current_date`).
- Every transition writes `garnishment_lifecycle_events` **and** emits a
  canonical `legal_order.<action>` event to `business_event_outbox`.
- Enterprise-domain alias `public.legal_order_transition` exposed for new code.
- `self_action_policy` seeded with SoD-block rows for every org × new
  action-key combination.
- Verified: RPC signature preserved, existing frontend calls keep working.

### Phase 2 — Pack contract (DONE)

- New enums: `legal_order_calc_model`, `legal_order_cap_membership`,
  `legal_order_completion_rule`.
- Extended columns on `localization_pack_garnishment_kinds` **and**
  `garnishment_kind_defaults`: `calc_model`, `priority_class`,
  `protected_earnings_rule` (jsonb), `aggregate_cap_membership`,
  `remittance_schedule_ref`, `evidence_requirements` (jsonb),
  `completion_rule`, `reporting_binding_ref`. Legacy booleans backfilled.
- New table `legal_order_kind_overrides` (org-scoped RLS; write =
  admin/owner only; unique per org × kind).
- New RPC `install_legal_order_kind_defaults(org, pack)` — idempotent
  upsert. `install-localization-pack` edge function calls it after GL
  finalize and reports counts under `summary.legal_order_kinds`.
- Verified: unique index `garnishment_kind_defaults_org_kind_uk` in place;
  install path is non-fatal on projection error.

### Phase 3 — Domain rename (DONE)

- `public.legal_order_authorities` (courts, tax agencies, child-support
  agencies, labor ministries, statutory bodies). Jurisdiction, contact,
  default payee routing, remittance & reporting bindings. Org-scoped RLS;
  write = admin/owner/accountant/super_admin.
- `employee_garnishments.authority_id` (nullable FK) — legacy free-text
  `issuing_authority` preserved for the transition period.
- `public.legal_orders` view (`security_invoker=true`) joins
  `employee_garnishments` with resolved `garnishment_kind_defaults` and
  exposes the full contract to consumers.
- Verified: view is invoker-mode (RLS enforced against caller); linter
  delta zero.

### Phase 4 — Engine + event emission (DONE, tests pending)

- `supabase/functions/_shared/garnishment-engine.ts` extended (backward
  compatible):
  - New optional `KindDefault` fields: `calc_model`, `priority_class`,
    `aggregate_cap_membership`, `protected_earnings_rule`.
  - `aggregate_cap_membership` supersedes legacy booleans when set.
  - `always_first` group applied before pooled orders; sort key is
    `(always_first desc, priority_class asc, priority asc)`.
  - Fallback to pack `calc_model` when order-level `cap_rule` is null.
    `statutory_formula` returns 0 (reserved for pack-scripted evaluators).
  - `protected_earnings_rule.{min_pct_of_gross, min_amount}` merged into
    the take-home floor.
- Client shim `src/lib/payroll/garnishment-engine.ts` re-exports the two
  new type unions (`LegalOrderCalcModel`, `LegalOrderCapMembership`).
- `post-garnishment-payment` emits `legal_order.payment_posted` to
  `business_event_outbox` after the lifecycle event (best-effort).
- **Pending in Phase 4:**
  - Add unit tests covering `always_first`, `priority_class`,
    `protected_earnings_rule`, and `calc_model` fallback branches.
  - Confirm `no-duplicate-garnishment-engine` architecture guard still
    passes after the shim re-export was widened.

### Phase 5 — Context-aware UI (NEXT — active phase)

Goal: the UI reflects the pack-published legal contract instead of
hard-coding fields. Scope:

1. Read from `public.legal_orders` (not `employee_garnishments`) wherever
   the UI needs the resolved contract. Add a `useLegalOrders` hook mirroring
   `useGarnishments` but reading the view.
2. In the order form:
   - Read `calc_model` from the resolved kind and show/hide `fixed_amount`
     vs `percent_of_disposable` accordingly.
   - Surface `evidence_requirements` — block save when required documents
     are missing.
   - Surface `completion_rule` — require `end_date` when `by_date`,
     require `total_owed` when `by_balance`, hide both when `indefinite`.
   - Replace the free-text authority input with a picker bound to
     `legal_order_authorities` (with an "add new authority" affordance for
     admins).
3. In the dashboard summary:
   - Show `priority_class` alongside priority.
   - Badge orders with `aggregate_cap_membership='always_first'`.
4. Guard rails: no route rename yet; keep `/hr/payroll/garnishments` as an
   alias and add `/hr/payroll/legal-orders` that renders the same shell so
   deep links keep working.

### Phase 6 — Consumer rewire (PENDING)

Migrate downstream consumers from polling the physical table to consuming
`legal_order.*` outbox topics:

- Remittance batch builder → `legal_order.payment_posted`,
  `legal_order.release`.
- Vendor / third-party statements → `legal_order.payment_posted`.
- Reporting extract jobs → `legal_order.activate`,
  `legal_order.mark_satisfied`, `legal_order.terminate_unsatisfied`.
- Notifications → `legal_order.activate`, `legal_order.approve`.

Also: expand `business_event_topics` seed with the full
`legal_order.<action>` set so the outbox worker recognises them.

---

## Files touched (this pass)

- `supabase/migrations/*` — three migrations (Phase 1, 2, 3).
- `supabase/functions/_shared/garnishment-engine.ts` — Phase 4 rewrite.
- `src/lib/payroll/garnishment-engine.ts` — shim widened.
- `supabase/functions/post-garnishment-payment/index.ts` — outbox emit.
- `supabase/functions/localization-pack/ops/install.ts` — pack projection.

---

## Handoff — instructions for the next agent

1. **Verify Phase 4 first (do not skip):**
   - Run `bunx vitest run src/lib/payroll/__tests__/garnishment-engine.test.ts`
     and `src/test/architecture/no-duplicate-garnishment-engine.test.ts` —
     both must pass unchanged. If either fails, fix before proceeding.
   - Add new unit tests for the four Phase-4 branches listed above
     (`always_first` reservation, `priority_class` ordering,
     `protected_earnings_rule` floor merge, `calc_model` fallback).
   - Quick end-to-end sanity: sign in as `owner`, create a draft legal
     order, and hit **Activate**. Expect 200 (not 403). Confirm the
     `business_event_outbox` receives `legal_order.activate`.
2. **Verify Phase 1–3 didn't drift:**
   - `select topic, count(*) from business_event_outbox where topic like 'legal_order.%' group by 1;`
     should show at least the activate row from the sanity check.
   - `select * from garnishment_kind_defaults where organization_id is not null limit 5;`
     — the Phase-2 columns must be populated for tenants that installed a
     pack after Phase 2 landed.
3. **Only then start Phase 5.** Do not begin Phase 6 first — the UI must
   already be reading from the view before we cut consumers over, or
   diagnosing UI regressions during Phase 6 becomes ambiguous.
4. **Do not** rename `employee_garnishments`, drop the free-text
   `issuing_authority`, or delete the client-side engine shim yet — those
   are explicit Phase-7 (cleanup) tasks after every consumer is on the
   view + outbox.
5. Update this file after each phase so it stays the single source of
   truth for status.
