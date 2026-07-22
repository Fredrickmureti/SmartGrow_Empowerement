# Payroll Legal Orders — Verification & Continuation Plan

## Phase 1 — Independent verification of prior agent's claims

Verified directly against the DB + repo (not the plan.md):

| Prior claim | Verdict | Evidence |
|---|---|---|
| P1: `garnishment_transition` rewritten with RLS-aligned roles + SoD + optional approval-workflow gate + outbox emit | **Confirmed** | `pg_get_functiondef('garnishment_transition')` shows role gate (admin/owner/accountant/super_admin + manager for suspend/resume), `governance_assert_not_subject`, workflow gate for activate/release/terminate_unsatisfied, `future-dated activation blocked`; migration `20260722225911_*` emits 11 `legal_order.*` outbox rows |
| P1: `legal_order_transition` alias exposed | **Confirmed** | `pg_proc` row present |
| P2: enums + extended `garnishment_kind_defaults` + `legal_order_kind_overrides` + `install_legal_order_kind_defaults` RPC | **Confirmed** | `calc_model`, `protected_earnings_rule` columns present; RPC present; overrides table present |
| P2: `install-localization-pack` projects pack rows | **Confirmed** | `install.ts:407` calls `install_legal_order_kind_defaults` and reports counts |
| P3: `legal_orders` view + `legal_order_authorities` + `employee_garnishments.authority_id` FK | **Confirmed** | view + table + FK all present |
| P4: shared engine extended with `calc_model`, `priority_class`, `aggregate_cap_membership`, `protected_earnings_rule`, `always_first` reservation | **Confirmed** | inspected `_shared/garnishment-engine.ts` |
| P4: `post-garnishment-payment` emits `legal_order.payment_posted` | **Confirmed** | line 285–288 |
| P4: unit tests for the 4 new branches | **NOT DONE** | test file has only the 8 legacy cases; no `always_first` / `priority_class` / `protected_earnings_rule` / `calc_model` fallback cases |
| P5: context-aware UI (view read, dynamic calc fields, authority picker, evidence gating, completion gating) | **NOT STARTED** | no `useLegalOrders`, no `from('legal_orders')`, no `authority_id`/`calc_model`/`evidence_requirements`/`completion_rule` bindings in `Garnishments.tsx` / `GarnishmentDashboard.tsx` / `useGarnishments.ts` |
| P6: consumer rewire onto `legal_order.*` outbox + topics seed | **NOT STARTED** | no subscribers, `business_event_topics` seed not extended |

Net: Phases 1–3 are genuinely complete; Phase 4 is code-complete but **tests are missing**; Phases 5 & 6 are untouched. No regressions found. The v3 plan is directionally correct — I extend it below rather than restart it.

## Phase 2 — Plan additions (gaps the prior plan did not name)

Reviewing against Workday IVDs / Oracle HCM 3PP / SAP EC Payroll / UK AEO / US CCPA:

- **A. Document evidence is not real.** Schema only has `document_url/filename` (a single link). The spec calls out uploaded/scanned court orders, versioning, retention, audit. Needs: `legal_order_documents` table (order → many docs, versioned, sha256, uploaded_by, retention_until), Storage bucket `legal-orders` with owner-only RLS, upload UI, and `evidence_requirements` gating that reads real document rows (not the free-text URL).
- **B. Approval-workflow configuration surface.** The RPC now requires an approved `approval_request` when a workflow exists for `entity_type='legal_order'`, but there is no UI/seed to create such a workflow. Without it, the gate is silently bypassed. Add: (1) a per-org default `approval_workflow` seed for `legal_order` when the pack policy demands it, (2) an "Approvals" tab entry so admins see/edit it, (3) auto-creation of an `approval_request` when a user submits a legal order (submit → pending_approval already exists in the FSM).
- **C. Finance liability + remittance are not event-derived yet.** Payslip posting creates the liability today via direct SQL. Phase 6 must add an outbox subscriber (`legal_order.payment_posted` → remittance batch line) and stop the direct-poll path so ownership is unambiguous.
- **D. `business_event_topics` seed** for the full `legal_order.<action>` set — currently missing; outbox worker will drop unknown topics.
- **E. Notifications.** Wire `legal_order.activate`, `legal_order.approve`, `legal_order.mark_satisfied`, `legal_order.terminate_unsatisfied` into `notification_alert_settings` so HR/finance are told, not just the DB.
- **F. Reporting projection.** `payroll_return_runs` and vendor/third-party statements must read from `public.legal_orders` (view) + outbox, not from `employee_garnishments` directly. Reporting extract job needs a hook.
- **G. Route + nav rename.** Add `/hr/payroll/legal-orders` route rendering the same shell; keep `/hr/payroll/garnishments` as alias (v3 plan calls this out, but adds no acceptance criteria — I'll assert both routes render + deep links redirect).
- **H. Effective-window enforcement in payroll compute.** `garnishment-engine.ts` accepts orders but does not filter by `start_date <= period_end AND (end_date IS NULL OR end_date >= period_start)` — verify + add.

## Phase 3 — Continuation roadmap (resume here)

### Phase 4b — Test backfill (start here)

Add to `src/lib/payroll/__tests__/garnishment-engine.test.ts`:
1. `always_first` reserves before pool; child_support kind default drives it.
2. `priority_class` orders two statutory kinds (tax_levy `class=2` before creditor `class=5`) irrespective of `priority` ties.
3. `protected_earnings_rule.min_pct_of_gross` merges with explicit floor (max wins).
4. `calc_model` fallback: order with `cap_rule=null` uses pack's `percent_disposable` model.

Then confirm `src/test/architecture/no-duplicate-garnishment-engine.test.ts` still passes.

### Phase 4c — Effective-window filter in engine

Add `period_start`/`period_end` args to `computeGarnishments`; skip orders outside window; unit-test future-dated + expired orders.

### Phase 5 — Context-aware UI

1. New hook `src/hooks/useLegalOrders.ts` reading `public.legal_orders` view — returns resolved kind contract (`calc_model`, `priority_class`, `evidence_requirements`, `completion_rule`, `aggregate_cap_membership`, `authority`).
2. Rewrite `Garnishments.tsx` form:
   - Kind picker seeds order defaults from resolved kind row.
   - Calc section shows only fields matching `calc_model` (fixed vs %disposable vs lesser_of vs statutory_formula placeholder).
   - Authority: replace free-text with `AuthorityPicker` bound to `legal_order_authorities` + "add new" affordance for admins.
   - Completion section: `by_date`⇒require `end_date`, `by_balance`⇒require `total_owed`, `indefinite`⇒hide both.
   - Evidence section: renders `legal_order_documents` list with upload; blocks Activate when required evidence missing.
3. `GarnishmentDashboard.tsx`: show `priority_class`, badge `always_first`, badge missing evidence, badge pending-approval.
4. Route alias `/hr/payroll/legal-orders` (same component); update `PayrollSidebar` label to "Legal Orders" with "Garnishments" as secondary.

### Phase 5b — Documents & Approvals (from gaps A & B)

- Migration: `legal_order_documents` table + `legal-orders` storage bucket + RLS.
- Migration: seed default `approval_workflow` per org on first pack install requiring approval; expose via existing Approvals surface.
- FSM: on `submit`, RPC auto-creates `approval_requests` row when workflow exists.

### Phase 6 — Consumer rewire + event fabric

1. Seed `business_event_topics` with every `legal_order.<action>`.
2. Outbox subscriber: `legal_order.payment_posted` → append remittance batch line (replace direct poll).
3. Reporting extract binds to `public.legal_orders` view.
4. Notification rules: activate/approve/mark_satisfied/terminate_unsatisfied.
5. Vendor statement export switches to view.

### Phase 7 — Cleanup

- Drop free-text `issuing_authority` after all rows have `authority_id`.
- Rename `employee_garnishments` → `legal_orders_records`; keep view.
- Remove `src/lib/payroll/garnishment-engine.ts` shim if all imports moved to canonical path (guard test permits).

## Technical notes

- All DB writes via migrations; grants + RLS reviewed per new table.
- Every phase ends with the same evidence: engine + architecture tests green, one live activation from a signed-in `owner` returning 200, `business_event_outbox` row visible.
- Documented per-phase in `docs/audit/` alongside `2026-07-22-legal-orders.md`.
- Plan.md updated after each phase so status stays honest.
