
# Payroll Legal Orders — Architecture Plan

## Findings (verified in the code, not assumed)

- **FSM exists, role gate is the 403.** `public.garnishment_transition(...)` in `supabase/migrations/20260630171133_*.sql` performs the transition, but line 82 hard-codes `has_role(actor,'admin') OR has_role(actor,'manager')`. Any signed-in user without one of those two roles gets `GARNISHMENT_FORBIDDEN (42501)`. There is no approval-workflow, no SoD check, no org-context check — it is a flat role gate that pretends to be policy.
- **Lifecycle table + audit exist.** `garnishment_lifecycle_events` + `garnishment_audit_log` are in place; the RPC writes events. Backfill is present.
- **Engine is real but duplicated by intent.** `src/lib/payroll/garnishment-engine.ts` is a re-export shim of `supabase/functions/_shared/garnishment-engine.ts`. The comment concedes the *full* production algorithm (per-period carry-forward, `total_accrued` cap, run-level state) still lives inline inside `supabase/functions/compute-payroll/index.ts`. **Two effective engines exist.**
- **Ledger is a view.** `garnishment_ledger` is queried directly; per the audit test it exists as a view (not a manually maintained table). Payment history is derived, but "derived from posted payslips" needs verification — the compute path writes ledger-shaped rows; whether finance events feed it is unverified.
- **Kind defaults are a table, not a pack contract.** `garnishment_kind_defaults` seeds `always_first`, `counts_toward_aggregate_cap`. Localization packs today (see `GarnishmentsEditor.tsx` and `localization_pack_garnishment_kinds` / `localization_pack_garnishment_policies` tables) publish *kinds and policy rows*, not full legal behaviour (validation, protected-earnings, remittance schedule, completion rules). Whether a tenant install actually seeds `garnishment_kind_defaults` from the pack — vs. relying on the global seed — is unverified and is one of the first things to prove.
- **UI is ahead of the engine.** `Garnishments.tsx` renders a full draft/submit/approve/activate FSM UI, mirrors the DB transitions in a local table, and calls the RPC. Calculation config is not context-aware (all fields visible for every `cap_rule`). The "aggregate cap exempt" toggle writes `aggregate_cap_exempt`, which the shared engine *does* read — so it is wired, but the UI presents it without policy context.
- **Approval workflow hook is only a comment.** `approval_workflows.entity_type` comment mentions `'garnishment_order'`, but nothing routes garnishment activation through `approval_requests`/`approval_workflow_steps`. Activation is one-shot RPC + role gate.

**Verdict:** the module is *not* a shallow facade — the FSM, event log, engine, and ledger are real. But it is architecturally shallow in four specific ways:
1. Authorization is a flat role check, not a policy (no workflow, no SoD, no jurisdiction context).
2. The "localization pack drives kind" claim is only partially true — packs publish labels + a couple of policy flags, not the *legal contract* (protected-earnings formula, priority class, remittance schedule, completion rule, required evidence).
3. Two engines coexist by design (shared subset + inline production algorithm), which will drift.
4. Domain naming (`employee_garnishments`) locks the model to one kind of legal order; child support, tax levy, student loan, bankruptcy all belong to the same aggregate.

## Architectural Target

Rename the bounded context to **Payroll Legal Orders**. Payroll executes, does not own. One canonical shape:

```text
LocalizationPack ──publishes──▶ LegalOrderKind (contract: calc model, priority class,
                                                protected-earnings rule, aggregate-cap
                                                membership, remittance schedule, evidence
                                                requirements, completion rule, reporting)
        │
        ▼
IssuingAuthority (managed entity, jurisdiction-scoped)
        │
        ▼
LegalOrder (draft ▶ pending_approval ▶ approved ▶ active ⇄ suspended
            ▶ satisfied | released | expired | terminated_unsatisfied ▶ archived)
        │              (transitions gated by ApprovalWorkflow + SoD, not raw role)
        ▼
PayrollRun ──executes──▶ garnishment engine (SINGLE implementation)
        │
        ▼
PayslipLine (event) ──▶ LegalOrderLedger (view, derived) ──▶ FinanceLiability
        │                                                            │
        └────────────────── domain events ───────────────────────────┴──▶ Remittance / GL / Reports
```

## Execution Plan (phased — each phase ships independently)

### Phase 0 — Diagnose without patching (this turn's build follow-up)
- Read `employee_garnishments` schema, current RLS, `approval_workflows` rows for `garnishment_order`, and confirm which role the current user actually holds. Confirm the 403 is the flat role gate and not a missing org context.
- Verify whether tenant install of a localization pack seeds `garnishment_kind_defaults` (trace `install-localization-pack` edge fn). Record the gap.
- Deliverable: a short verified-findings note in `docs/audit/2026-07-22-legal-orders.md`. No code change.

### Phase 1 — Authorization becomes policy, not role
- Introduce `legal_order_transition_policy` (per org, per action) resolved via existing SoD framework (`self_action_policy` / `governance_assert_not_self`). Activation requires: (a) permission `payroll.legal_order.activate`, (b) not self, (c) optional approval-workflow step when configured.
- Rewrite `garnishment_transition` to: check permission via `has_permission`, call `governance_assert_not_subject` when actor == employee's user, and — when an `approval_workflow` exists for `entity_type='legal_order'` — require an `approved` `approval_request` for the target order before allowing `activate`.
- Keep the RPC name for back-compat; add `legal_order_transition` alias.
- Fix the 403 as a consequence, not the goal.

### Phase 2 — Localization pack publishes legal behaviour
- Extend the pack contract (`localization_pack_garnishment_kinds` → `localization_pack_legal_order_kinds`) with structured columns:
  `calc_model`, `priority_class` (statutory rank), `protected_earnings_rule` (jsonb, evaluated by shared engine), `aggregate_cap_membership` (`in_pool` | `exempt` | `always_first`), `remittance_schedule_ref`, `evidence_requirements` (jsonb), `completion_rule` (`by_balance` | `by_date` | `by_court_order`), `reporting_binding_ref`.
- Install-time: `install-localization-pack` must upsert into `garnishment_kind_defaults` from these rows so tenant behaviour is 100% pack-driven. No global hardcoded seed remains authoritative after a pack is installed.
- Tenant editor becomes read-only for pack-owned fields; overrides go through `payroll_certificate_template_overrides`-style override table (`legal_order_kind_overrides`).

### Phase 3 — Domain rename + issuing-authority entity
- Introduce `legal_order_authorities` (managed entity: name, jurisdiction, remittance defaults, contact, statutory identifiers). Migrate `employee_garnishments.issuing_authority` (text) to `authority_id` (fk) with a text fallback column for legacy rows.
- Create `legal_orders` **view** over `employee_garnishments` as the public read shape; keep the table until a table rename is scheduled. New code reads the view; writes still go through the RPC.
- Case Reference becomes structured: `{authority_id, case_number, jurisdiction_code}` composite unique.

### Phase 4 — Single engine, canonical events
- Extract the production algorithm from `supabase/functions/compute-payroll/index.ts` (carry-forward, `total_accrued`, per-run state) into `_shared/garnishment-engine.ts`. Delete the inline copy. Architecture test to forbid re-inlining.
- `garnishment_ledger` becomes strictly a view over `payslip_lines` filtered by kind + `garnishment_id`, plus employer-fee lines. Any write path that inserts ledger rows directly is removed.
- Emit `business_event_outbox` events: `legal_order.activated`, `legal_order.applied` (per payslip line), `legal_order.satisfied`, `legal_order.released`, `legal_order.terminated`. Finance liabilities and remittance schedules subscribe.

### Phase 5 — Context-aware UI
- `Garnishments.tsx` calculation section becomes a discriminated form driven by the pack's `calc_model` — only relevant fields render (Fixed → amount; % of Disposable → percent + floor; Balance-based → total_owed; Statutory → read-only).
- Priority becomes read-only, derived from `priority_class` published by the pack; user cannot outrank a statutory order with a creditor.
- Aggregate-cap toggle disappears when the pack declares the kind as `always_first` or `exempt`; only shown when the kind's membership is legally overridable.
- Activate button hidden unless the caller has the resolved permission and, when a workflow exists, an approved request is present. All refusal messages route through `parseGovernanceError`.

### Phase 6 — Consumers audited & consolidated
- Verify each consumer (payslip renderer, GL posting, remittance generator, statutory certificates, notifications, ESS `MyGarnishmentsTab`) reads from the single `legal_orders` view + outbox events. Any duplicate interpretation of legal rules in the frontend is deleted.

## Non-negotiables

- No new hardcoded jurisdiction logic anywhere outside a localization pack.
- No new writer of `employee_garnishments` outside the RPC (enforce with a trigger + architecture test).
- Frontend never re-implements calc/priority — it renders what the pack contract says.
- All lifecycle transitions produce a `garnishment_lifecycle_events` row AND a `business_event_outbox` event.

## What I will do first when build mode opens

Only Phase 0 (verified diagnosis, no code change). I will not touch the 403 until Phase 1 lands, because fixing the role check without policy is exactly the shallow patch this brief forbids.

## Open questions before I start Phase 1

1. Confirm you want the domain renamed to **Legal Orders** at the API/view layer now (table rename deferred), vs. keeping `garnishment_*` naming throughout.
2. Confirm activation should require an **approval workflow** when one exists for `entity_type='legal_order'`, and otherwise fall back to a permission + SoD check. (Alternative: always require an approval workflow — stricter, more disruptive.)
3. Confirm localization packs should become the **sole** authority for kind behaviour after install (with the global `garnishment_kind_defaults` seed acting only as a bootstrap for uninstalled tenants).

I'll ask these as questions after you accept the plan, unless you'd rather answer them inline now.
