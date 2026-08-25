# Projects Domain — Reconstruction (live authoritative status)

This file is the live status for the Projects module rebuild. Verified facts only.
Historical records live in `.lovable/plan/`.

## Handover verification, 2026-08-26 (read from the live DB and codebase, not inferred)

Independent re-verification of the previous engineer's Wave 5 claims:

| Claim | Verdict | Evidence |
|---|---|---|
| 5.1 ledger integrity (nature/FX/grain) | Confirmed | `project_cost_entries` carries `entry_nature`, `amount_base`, `fx_rate`, `base_currency`; both upsert writers exist; `compute_project_profitability(project, business)` is a 5k-char plpgsql function |
| 5.1 UI wiring | Confirmed | `useProjectFinancials.ts` types and `ProjectFinancials.tsx` render committed totals and the unconverted-FX warning |
| 5.2 budget authority | Confirmed in part | `budget_source: budgets_domain \| project_scalar \| none` is returned and rendered; budget-vs-actual read still needs a variance check against the budgets domain revision model |
| 5.3 invoicing round-trip | Not verified complete | `invoice-project-timesheets` / `invoice-project-milestone` edge functions exist and call `mark_timesheets_invoiced`, but selection + marking are not one transaction and no test proves double-billing is impossible |
| 5.4 analytic linkage | Not started | `project_analytic_reconciliation` exists; no evidence every posting path stamps the project analytic account |
| Branch enforcement blocker | Resolved server-side | `project_can_read` enforces `user_can_access_branch` plus module permission and membership/privacy |

Waves 1–4 remain accepted as previously verified; nothing found in this pass contradicts them.

## Where the work stands

| Wave | Scope | State |
|---|---|---|
| 1–4 | Domain model, config/templates, tasks, workforce & timesheets | Complete |
| 5 | Commercial & financial integration | 5.1 and 5.2 landed; 5.3–5.5 outstanding — ACTIVE |
| 6 | Milestones, documents, collaboration, outbox topics | Pending |
| 7 | Reporting & read models | Pending |
| 8 | End-to-end business simulation and security verification | Pending |

## Remaining execution order

### Wave 5 (finish)
- **5.3 Invoicing round-trip.** Move timesheet/milestone billing into a single
  server-side transactional RPC that selects, invoices and marks source rows in one
  step, with an idempotency guard so a retry or two concurrent clicks cannot
  double-bill. Invoice lines must carry `project_id` (and task/milestone) so the
  revenue feeder picks each up exactly once as an `actual`.
- **5.4 Analytic linkage.** Every posting path (timesheet cost, vendor bill, invoice,
  milestone) stamps the project's analytic account; audit with
  `project_analytic_reconciliation` and fail the audit loudly on drift.
- **5.5 Wave 5 verification.** SQL scenario test for a full commercial round trip
  (time logged → invoiced → paid → profitability) plus the guard tests; `tsgo` clean.

### Wave 6 — Milestones, documents, collaboration
- Milestone lifecycle as a business event (approval → billable release), not a progress bar.
- Documents consume the canonical document engine with tenant/business/branch/membership
  authorization on both metadata and download.
- `projects.*` outbox topic registration confirmed; notifications scoped so no
  cross-business or cross-branch delivery is possible.

### Wave 7 — Reporting & read models
- Identify or write the producers for `project_burndown_daily` and
  `project_portfolio_kpis`; no shadow totals without a defined projection owner.
- Every report/export defines tenant, business, branch and role scope server-side;
  aggregates cannot leak across businesses.
- Retire client-side `applyBranchFilter` from project reads now that `project_can_read`
  enforces branch server-side.

### Wave 8 — Full lifecycle business simulation (the acceptance run)
Drive the module the way a real customer would, in the browser, fixing every defect hit:
1. CRM won lead → project created from the lead (customer, currency, branch, template).
2. Configure: stages, pricing model, billable flag, budget, allocated hours, privacy.
3. Assign a project manager and team members, including a cross-branch attempt that must be refused.
4. Create tasks, assign, transition through the task lifecycle, test concurrent edits.
5. Log timesheets as an employee; approve as manager; check workload and rate resolution.
6. Record expenses/bills against the project; verify cost ledger nature and FX.
7. Complete milestones; bill timesheets and milestone; post invoice; receive payment.
8. Close the project with open work outstanding, then correctly; verify history stays readable.
9. Role matrix pass: admin, project manager, team member, finance user — each of
   My Tasks, All Tasks, Projects, Milestones, Documents, Workload, Reports, Configuration.
10. Security pass: forged project/task/employee/template/branch IDs, cross-business
    search, unauthorized export and document download, realtime subscription scope.

## Working rules
- One migration per object, single-purpose — never batched.
- Update this file immediately after each numbered item lands, with the evidence.
- No fallbacks left behind: a replaced writer is deleted, not kept beside the new one.
- Nothing is "done" without a test or a live trace proving the business event end to end.
