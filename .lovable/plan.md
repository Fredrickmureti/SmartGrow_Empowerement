# Payroll Parallel-Workflows Redesign — final status (2026-07-05)

## Independent verification (this session)

The prior agent's plan was mostly directionally right but contained one
material misdiagnosis and left several genuinely-required pieces undone.

### Verified correct in the prior work
- **Phase 1** — workflow-state columns on `payroll_runs`
  (`posting_status`, `payment_status`, `bank_file_status`,
  `payslip_issuance_status`) with back-fill (`20260705195822`).
- **Phase 2** — `generate-statutory-return`, `generate-tax-certificate`,
  `post-payroll-gl` all gate on `approved_at IS NOT NULL`, pinned by
  `parallel-workflows-preconditions.test.ts`.
- **Phase 3** — payment-status projection triggers +
  `payroll_bank_files` table (`20260705200306`).
- **Phase 5a/c/d/e/f** — `usePayrollWorkflows` hook family, workflow
  strip, matrix, drawer host, run lifecycle timeline, no
  "must be paid" copy remaining. Mounted in `PayrollControlCenter.tsx`.

### Misdiagnosis corrected
The prior plan asserted the tax-cert 500 was caused by
`payroll_employee_ytd_rollup` being called with the wrong arity. That is
**false**: the RPC's real signature in `20260510081521` is
`(p_year integer, p_employee_id uuid)`, which is exactly what
`generate-tax-certificate` passes. Applying that "fix" would have
broken production. `payroll_remittance_dashboard` also works correctly
at DB level when called with the client's argument shape.

The real user-visible errors are business-condition refusals surfacing
as raw HTTP status codes. Fixed in this session (see below).

## Delivered this session

1. **True root-cause fix for the 404/500 the user reported.**
   - `generate-statutory-return`: raw `404 "template not found"` → structured
     `businessError("TEMPLATE_NOT_INSTALLED", …)` with recovery action
     pointing at Settings → Localization → Packs.
   - `generate-tax-certificate`: same treatment. The prior code returned
     bare 404s that the UI showed as opaque errors.
   - Both edge functions redeployed.
   - Regression test: `src/test/payroll/tax-certificate-rpc-signature.test.ts`
     pins both the real RPC signature AND the businessError contract so
     future audits can't re-open the same misdiagnosis.

2. **Fixed build errors the prior agent left behind.**
   - `PayrollRunLifecycleTimeline.tsx` was querying a non-existent
     `aggregate_id` column on `business_event_outbox`; migrated to
     `source_doc_id` which is the real column.
   - `usePayrollWorkflows.ts` referenced `paid_at` / `paid_by` on
     `payroll_runs` (don't exist) and `payroll_period_id` on
     `payroll_remittances` (schema uses `payroll_run_id`). Rewrote to
     `payment_date` and to resolve run ids first.
   - `.replaceAll` calls in four components → `.replace(/_/g, …)` for
     the project's TypeScript lib target.

3. **Phase 4b — parallel-workflow-aware period close.**
   New migration (`payroll_period_close_waivers` table + partial unique
   indexes + `payroll_period_workflow_blockers` RPC + extended
   `payroll_period_close_atomic`). Period close now refuses to advance
   while any of posting, payment, bank_file, or statutory returns is
   outstanding, unless waived or explicitly forced. Emits
   `payroll_period.close_blocked` and `payroll_period.closed` to the
   `business_event_outbox`.

4. **Phase 6a — legacy `payroll_runs.status` retirement.**
   - Column comment marks `posted`/`paid` DEPRECATED.
   - `payroll_runs_legacy_status_v` compatibility view.
   - Architecture test `src/test/architecture/no-legacy-payroll-status-reads.test.ts`
     ratchets the 11 known coupling sites and forbids new ones. New code
     added to the allow-list requires a matching ADR-0058 update.

5. **Phase 6c — ADR-0058 + cross-reference addenda.**
   - `docs/adr/0058-payroll-parallel-workflows.md` — the definitive
     "downstream workflows are peers of Approval" decision, with
     enterprise inspiration citations (SAP HCM, SuccessFactors, Workday,
     Oracle HCM, ADP, Odoo) and enforced invariants.
   - `docs/adr/0058-addendum-cross-references.md` — addenda to
     ADR-0022 (immutability on `locked_at`, not status label),
     ADR-0036 (Approval is the certificate boundary),
     ADR-0036-addendum (provenance from approved runs only),
     ADR-0045 (batches orchestrate but do not gate).

## Test status

`bunx vitest run src/test/architecture/no-legacy-payroll-status-reads.test.ts src/test/payroll/tax-certificate-rpc-signature.test.ts src/test/payroll/parallel-workflows-preconditions.test.ts`
→ **10 / 10 passing.**

## Deferred (with rationale)

- **Phase 4a — dotted-key workflow permissions.** Tenant RBAC in this
  project is module-based (`permission_group_rules.module + can_write`),
  not key-based. Splitting `payroll.write` into
  `payroll.calculate`/`payroll.approve`/… requires a governance-wide
  RBAC redesign that has non-payroll blast radius (invoicing, inventory,
  etc.) and should be sequenced separately. Documented for a future ADR.
- **Migrating the 11 allow-listed `payroll_runs.status` readers.** The
  ratchet test forbids new couplings; the existing 11 sites can migrate
  one-by-one to the workflow-state columns / compatibility view.

## Out of scope

- Off-cycle/retro engine (M-PAY-6).
- Multi-currency payroll runs.
- Cross-legal-entity consolidation beyond `v_payroll_period_consolidation`.
