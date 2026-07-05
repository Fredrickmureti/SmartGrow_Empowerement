
## Independent status assessment

I re-verified the previous agent's claims against the actual codebase — most match, but the diagnosis of the user-visible failures is **wrong**, and phases 4b, 6a/b/c are genuinely not done.

### Verified done (kept as-is)
- **Phase 1** — workflow-state columns (`posting_status`, `payment_status`, `bank_file_status`, `payslip_issuance_status`) with CHECK domains + back-fill are in `20260705195822_*.sql`.
- **Phase 2** — `generate-statutory-return`, `generate-tax-certificate`, `post-payroll-gl` all gate on `payroll_runs.approved_at IS NOT NULL` (pinned by `parallel-workflows-preconditions.test.ts`).
- **Phase 3** — payment-projection trigger + `payroll_bank_files` table shipped in `20260705200306_*.sql`.
- **Phase 5a/c/d/e** — `usePayrollWorkflows` hook family, `WorkflowMatrix`, `WorkflowDrawer`, `WorkflowMatrixDrawerHost`, `PayrollRunLifecycleTimeline`, `PayrollWorkflowStrip` all exist and are mounted in `PayrollControlCenter.tsx`.
- **Phase 5f** — no "must be paid before returns" copy remains.

### Verified incorrect in the previous plan
- The previous agent claimed the tax-cert 500 was caused by `payroll_employee_ytd_rollup` being called with only `(p_year, p_employee_id)` instead of a 4-arg signature. **False.** The RPC's real signature in `20260510081521_*.sql` is `(p_year integer, p_employee_id uuid)` — exactly what the edge function passes. That "fix" would break the call.
- The plan also assumed `payroll_remittance_dashboard` 400 is a signature mismatch. The client passes `{ p_organization_id, p_business_id }` and the RPC exists — need to actually reproduce and read the DB error, not patch blindly.

### Genuinely not done
- **Phase 4b** — period-close waivers table + terminal-state enforcement in `payroll_period_close_atomic`.
- **Phase 6a** — deprecate legacy `payroll_runs.status` values, add compatibility view + architecture guard.
- **Phase 6c** — ADR-0058 + addenda to 0022, 0036, 0045.
- **True root-cause investigation of the three user-reported errors.** No one has actually reproduced them; the previous agent skipped straight to a wrong hypothesis.
- **Phase 4a** (workflow-scoped permission keys) — correctly deferred: current RBAC is module-based, splitting requires a governance-wide redesign out of scope for this slice.

---

## Plan

### Step 1 — Reproduce and diagnose the three real errors (no speculative fixes)

Drive the live app via Playwright as an authenticated user, navigate through Compliance → Tax Certificates and Remittances → Returns, capture:
- exact edge-function response bodies (the 500 and 404),
- exact PostgREST payload for the `payroll_remittance_dashboard` 400,
- Supabase edge-function logs for both functions.

Likely causes (to be confirmed, not assumed):
- **404 on `generate-statutory-return`** — the function exists in the repo but may not be deployed to this project; verify via `supabase--curl_edge_functions` and redeploy if missing.
- **500 on `generate-tax-certificate`** — most probable real causes: (a) no `localization_pack_certificate_templates` installed for the org's active pack, (b) no approved runs for the FY (business error surfacing as 500 due to unhandled throw), (c) storage bucket write failure. Fix the actual cause and convert any business precondition failures to structured 4xx `businessError` responses (matching the pattern already used for `NO_APPROVED_PAYROLL_RUNS`).
- **400 on `payroll_remittance_dashboard`** — read the Postgres error text; most likely a nullable arg or a return-shape mismatch after a recent migration. Fix at the RPC or the caller, add a signature regression test.

Deliverable: a short diagnosis note appended to `.lovable/plan.md`, then the minimum surgical fix for each, each with a regression test.

### Step 2 — Phase 4b: period close hardening

Migration:
- `payroll_period_close_waivers(period_id, workflow, reason, created_by, created_at)` with the mandatory 4-step pattern (CREATE → GRANT → ENABLE RLS → POLICY scoped to org/business).
- Extend `payroll_period_close_atomic` to require, for every run in the period: `approved_at IS NOT NULL`, `posting_status IN ('posted','reversed')` or waiver, `payment_status IN ('fully_paid','on_hold')` or waiver, `bank_file_status IN ('sent','acknowledged','not_generated_waived')` or waiver, and all statutory returns `submitted`/`accepted` or waived.
- Emit `payroll_period.closed` to `business_event_outbox`.
- Keeps the existing module-based `payroll.can_write` permission — no RBAC redesign.

### Step 3 — Phase 6a: retire coupled reads of `payroll_runs.status`

- Migration: column comment marking `posted`/`paid` deprecated; add `payroll_runs_legacy_status_v` view derived from the new workflow columns.
- Grep-audit remaining internal readers, migrate them to the workflow columns.
- Architecture test in `src/test/architecture/` forbidding new code from reading `payroll_runs.status` for anything outside `draft|calculating|calculated|approved|cancelled|reversed`.

### Step 4 — Phase 6c: governance docs

- `docs/adr/0058-payroll-parallel-workflows.md` — "Downstream payroll processes are peers of Approval, not a chain."
- Addenda to ADR-0022 (immutability keyed on `locked_at`), ADR-0036 (Approval is the certificate/return boundary), ADR-0045 (batch orchestrates, does not gate).

### Step 5 — Integration verification

- End-to-end Playwright pass: fresh org → contract → payroll → approve → open Control Center → confirm workflow strip + matrix render → open each drawer → generate tax certificate → generate statutory return → run remittance dashboard. Capture screenshots as evidence.
- Run the full `src/test/payroll/**` suite and the architecture guards.

### Explicitly out of scope (unchanged from prior plan)
- Phase 4a workflow-scoped permission keys — requires governance-wide RBAC redesign.
- Off-cycle/retro engine, multi-currency payroll, cross-legal-entity consolidation.

---

## First deliverable if approved

Step 1 (real root-cause diagnosis + surgical fixes for the 500/404/400 with regression tests) — this is what the user actually reported. Steps 2–5 follow in the same session without regressions.
