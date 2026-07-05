
# Continue Payroll Parallel-Workflows Redesign (Phases 4–6)

## What I verified is already done

Independent inspection of the codebase (not agent claims):

- **Phase 1 — Immutability + workflow-state columns.** `20260705195822_*.sql` adds `posting_status`, `payment_status`, `bank_file_status`, `payslip_issuance_status` with CHECK domains, indexes, and legacy-status back-fill. ✓
- **Phase 2 — Returns/GL cut loose from Payment.** `generate-statutory-return/index.ts` now gates on `payroll_runs.approved_at IS NOT NULL` and emits `NO_APPROVED_PAYROLL_RUNS` with `requires: "payroll_runs.approved_at"`. `post-payroll-gl/index.ts` gates on `approved_at`, not on `status='paid'`. ✓
- **Phase 3 — Payment projection + Bank File table.** `20260705200306_*.sql` ships `payroll_recompute_run_payment_status(uuid)`, two triggers on `payroll_payment_batch_items` / `payroll_payment_batches`, a back-fill DO-block, and the `payroll_bank_files` table with RLS + roll-up trigger to `payroll_runs.bank_file_status`. ✓
- **Tax certificate 500 root cause.** `generate-tax-certificate` still calls `payroll_employee_ytd_rollup(p_year, p_employee_id)` — but only two params; the RPC signature has `(p_organization_id, p_business_id, p_year, p_employee_id)` in reality (verify + fix as part of Phase 5 wiring). Also the dashboard `payroll_remittance_dashboard(uuid, uuid)` was re-created in `20260705192321_*.sql` — need to verify signature matches the client call (400 was likely arg-mismatch).
- **`payroll_period_close_atomic`** already exists (pre-plan, from `20260703211836` / …213007), and is used by `usePayrollPeriods`. It needs an **audit** against the new workflow-state columns (must require each workflow to be in a terminal or explicitly-waived state, not just `payroll_runs.status`).
- Workflow-scoped hooks (`usePayrollPostingWorkflow`, …), workflow strip UI, matrix overview, per-workflow drawers, lifecycle timeline for a run, and the ADR for parallel workflows are **not present**.

## Remaining work

### Phase 4 — Workflow permissions + period-close alignment

- **4a. Split `payroll.write`** into workflow-scoped permission keys: `payroll.calculate`, `payroll.approve`, `payroll.post_gl`, `payroll.pay`, `payroll.bank_file`, `payroll.returns.generate`, `payroll.returns.submit`, `payroll.remit`, `payroll.period.close`. Migration:
  - Insert the new keys into the permission catalog.
  - Backfill: every `permission_group_rules` row granting `payroll.write` grants all 9 new keys (idempotent, keyed on `(group_id, permission_key)`).
  - Keep `payroll.write` as a legacy super-alias resolved in the RBAC helper for one release; mark deprecated in a comment.
  - Update each RPC / edge-fn permission check to require its specific key, falling back to `payroll.write` while legacy alias exists.
- **4b. Period close** — extend `payroll_period_close_atomic` (or add a wrapper `payroll_period_close(period_id, opts)`) to require, for every run in the period:
  - `approved_at IS NOT NULL`
  - `posting_status IN ('posted','reversed')` OR waiver row
  - `payment_status IN ('fully_paid','on_hold')` OR waiver row
  - `bank_file_status IN ('sent','acknowledged','not_generated_waived')` OR waiver row
  - all statutory returns for the period are `submitted`/`accepted` or waived
  - Waivers written to a small `payroll_period_close_waivers(period_id, workflow, reason, created_by, created_at)` table (RLS scoped to org/business, insert-only from RPC).
  - Emit `payroll_period.closed` on `business_event_outbox`.

### Phase 5 — Control Center rebuild (workflow board)

- **5a. Workflow hooks.** New `src/hooks/payroll/workflows/`:
  - `usePayrollPostingWorkflow(runId)`
  - `usePayrollPaymentWorkflow(runId)`
  - `usePayrollBankFileWorkflow(runId)`
  - `usePayrollReturnsWorkflow(runId | periodId)`
  - `usePayrollRemittanceWorkflow(periodId)`
  - `usePayrollPeriodCloseWorkflow(periodId)`
  - Each returns `{ state, canAdvance, preconditions: Array<{code, message, satisfied}>, actions, lastActor }`.
- **5b. Workflow strip.** New `WorkflowStrip` component: 6 chips (Calculation · Payslips · Posting · Payment · Bank File · Returns · Remittance) with color-coded status, last-actor tooltip, and click-to-open drawer. Replaces the current linear action bar in `PayrollControlCenter.tsx`.
- **5c. Matrix overview.** New `WorkflowMatrix` (rows = periods for current business, columns = workflows, cells = state chip). Added as the top section of `PayrollControlCenter`.
- **5d. Per-workflow drawers.** Six focused drawers replace the monolithic run detail dialog; each drawer surfaces only that workflow's preconditions, actions, and audit list. Old monolithic content stays reachable through a "Full run detail" link for one release.
- **5e. Lifecycle timeline.** New `PayrollRunLifecycleTimeline` (sibling to `PayslipEventsTimeline`) reading `business_event_outbox` filtered to `payroll_posting.*`, `payroll_payment.*`, `payroll_return.*`, `payroll_remittance.*`, `payroll_period.*` for the run's period. Rendered inside the drawer sidebar.
- **5f. Copy sweep.** Remove any UI text that reads "Pay employees before generating returns / certificates" — replace with "Available after Approval". Grep targets: `src/pages/hr/payroll/**`, `src/components/payroll/**`, `useStatutoryReturns`.
- **5g. Tax certificate + remittance dashboard bug fixes** rolled into this phase because they are the user's original report:
  - Verify the actual signature of `payroll_employee_ytd_rollup` against `generate-tax-certificate`; fix the call to include `p_organization_id` + `p_business_id` (root cause of 500).
  - Verify `payroll_remittance_dashboard(uuid, uuid)` signature vs client hook and align (root cause of 400).
  - Add regression tests: `src/test/payroll/tax-certificate-rpc-signature.test.ts` and `src/test/payroll/remittance-dashboard-signature.test.ts`.

### Phase 6 — Retire legacy coupling + governance

- **6a. Deprecate legacy `payroll_runs.status` values.** Migration that:
  - Adds a comment on the column marking `posted`/`paid` as deprecated.
  - Introduces a `payroll_runs_legacy_status_v` compatibility view derived from the new columns.
  - Migrates last two internal readers (grep-audited) to the new columns.
  - Adds an architecture test forbidding new code from reading `payroll_runs.status` for anything other than `draft|calculating|calculated|approved|cancelled|reversed` (regex guard in `src/test/architecture/`).
- **6b. Retire `payroll.write` alias** once all callers use the new keys (guarded by an eslint rule in `eslint-rules/no-payroll-write-permission.js`).
- **6c. ADR + addenda.**
  - New ADR: `docs/adr/0058-payroll-parallel-workflows.md` — "Payroll downstream processes are peers of Approval, not a chain."
  - Addendum to ADR-0022: immutability keyed on `locked_at`, not status label.
  - Addendum to ADR-0036: Approval, not "paid", is the completion boundary for certificates and returns.
  - Addendum to ADR-0045: Batch orchestrates but does not gate downstream workflows.

## Technical details

- Migrations: one per phase-slice (4a permissions, 4b close, 5g signature fixes, 6a legacy retire, 6b alias retire). Every new table follows the mandatory 4-step pattern (CREATE → GRANT → ENABLE RLS → POLICY).
- All new RPCs `SECURITY DEFINER SET search_path = public`, emit `business_event_outbox` rows, idempotent on `(run_id | period_id, workflow, target_state)`.
- Immutability guard bypass: extend the ADR-0045 `stack_context` allow-list to name each workflow explicitly (`workflow=posting` may write only `posting_*` columns, etc.).
- Frontend hooks live under `src/hooks/payroll/workflows/`; shared `WorkflowPreconditionList` component. Query keys namespaced `["payroll","workflow",<name>,runId|periodId]`.
- No country hardcoding — statutory preconditions continue to derive from `payroll_statutory_rules` + localization packs.
- Tests: architecture guard forbidding reads of `payroll_runs.status` outside allowed literal set; RPC-signature regression tests for tax-cert + remittance dashboard; unit tests for the six workflow hooks; a Playwright smoke that opens Control Center, sees the workflow strip, and opens each drawer.

## Out of scope

- Off-cycle/retro engine (M-PAY-6).
- Multi-currency payroll runs.
- Cross-legal-entity consolidation beyond `v_payroll_period_consolidation`.

## First deliverable if approved

Phase 5g (fix the user-visible 500 / 400 / 404 with the correct architectural preconditions verified in Phases 1–3) + Phase 5a-b (workflow hooks + workflow strip) — this restores Tax Certificates and Returns end-to-end and gives the UI its enterprise-grade shape. Phases 4, 5c-f, and 6 follow in subsequent turns without regressions.
