# Analytic Accounting Domain — Handover Verification Verdict and Phase 4 Closure Plan

Source of truth for this domain. Forensic findings and roadmap:
`.lovable/plan/analytic-accounting-domain-forensic-assessment-2026-08-23.md`.

Last updated: 2026-08-23 (second handover verification). Active phase: **Phase 4 — Producers (project ledger reconciliation)**.

## Phase 1 — Verification of the previous engineer's claims

Checked directly against the live database and the code, not against the previous notes.

| Claim | Verdict | Evidence |
|---|---|---|
| Phase 0/1/2 — plans, lifecycle, scoped RLS, no fabricated balance | Confirmed | 4 rows in `analytic_plans` (`cost_center`, `department`, `product_line`, `project`); `analytic_accounts.plan_id` + `status` present; guards `_analytic_account_guard` (plan/company immutable once attributed) and `_analytic_account_delete_guard` live. |
| Phase 3/3b — posting engine and immutability | Confirmed | `_jel_sync_analytics` raises on any update to a line whose entry is `posted`/`voided`, skips zero-value lines, rejects foreign-company and non-`active` accounts, writes signed amount + `percentage = 100`. `analytic_balances` is SECURITY DEFINER, pinned search_path, gated by `user_can_access_business` + `user_has_module_permission`, counts `posted`/`reversed` only, accepts a branch filter. |
| Phase 4 — producers reach the GL | Confirmed structurally | `analytic_account_id` exists on `journal_entry_lines`, `bill_items`, `invoice_items`, `expenses`, `purchase_requisitions`, JELA. `confirm_bill_atomic` and `build_invoice_je_lines` group JE lines by resolved GL account **and** `analytic_account_id`; `post_journal_entry_atomic` carries `analytic_account_id` per line. |
| Phase 5 — consumers | Confirmed not started | No analytic report in `ReportRegistry.ts` / `reportsNav.ts`. |
| Engine proven end to end | **Not proven** | Live counts: `analytic_accounts` = 0, JELA = 0, `journal_entry_lines` with an analytic account = 0, `projects` = 0. Every tie-out assertion is still vacuous. |

## New findings from this verification (these change the Phase 4 plan)

1. **FACT — project attribution never reaches the GL.** `journal_entry_lines.project_id` exists and is indexed, but no posting function writes it: the only function whose body touches both `journal_entry_lines` and `project_id` is `void_journal_entry_atomic`. So `LineAnalyticsCell` (project/task on invoice, SO, PO and bill lines) produces attribution that the analytic ledger can never see.
2. **FACT — the expense path resolves project → analytic account by text code.** The expense posting function matches `analytic_accounts.code = projects.analytic_account_code`. `analytic_account_code` is a free-text field typed by the user in `ProjectForm.tsx` with no FK, so this lookup is silently null in practice.
3. **FACT — the project ledger is coherent, not junk.** `project_cost_entries` is written by per-source triggers (`trg_bill_to_cost`, `trg_expense_to_cost`, `trg_timesheet_to_cost`, `trg_purchase_order_to_cost`, `trg_stock_movement_to_cost`) plus `trg_je_line_to_project_ledger`, and the JE mirror deliberately restricts itself to manual/unsourced entries so the two writers do not double count.
4. **Challenge to the previous plan.** The previous engineer's instruction was to make `project_cost_entries` "derived" from the GL analytic ledger. That would destroy real capability: timesheet labour cost, PO commitments and stock movements are legitimately non-GL or pre-GL, and no analytic ledger row exists for them. The correct target is narrower and stricter: **GL-backed project cost is attributed once, in the analytic ledger; the project ledger keeps only operational/non-GL sources; the two are reconciled by a server-side function rather than left to diverge silently.**

## Phase 4 closure — work to execute (one migration + thin UI wiring)

1. **Bind projects to the analytic ledger.** Add `projects.analytic_account_id` (FK to `analytic_accounts`, `ON DELETE RESTRICT`); retire the free-text `analytic_account_code` and its input in `ProjectForm.tsx` / `useProjects.ts`.
2. **Auto-provision.** BEFORE INSERT/UPDATE trigger on `projects`: ensure the business has a `project` analytic plan, upsert one analytic account per project (code from `project_number`, name from the project), and keep its `status` in step with the project (`active` while the project is open, `archived` on close). Never create a second account for an existing project.
3. **Resolve project → analytic account at posting.** Add `public.project_analytic_account_id(uuid)` (STABLE, SECURITY DEFINER, pinned search_path) and use `COALESCE(line.analytic_account_id, project_analytic_account_id(line.project_id))` as the analytic grouping key in `confirm_bill_atomic` and `build_invoice_je_lines`, and as the resolution in the expense posting path (replacing the text-code match). Manual JE lines keep the explicit picker.
4. **Stop the two ledgers diverging.** Keep the per-source project-ledger triggers for non-GL sources; add a server-side `project_analytic_reconciliation(business_id, date_from, date_to)` returning, per project, GL analytic net vs project-ledger cost and the difference, authorized the same way as `analytic_balances`. Point `src/components/projects/LineAnalyticsCell.tsx` at the same picker contract used in Finance so a project tag is understood as analytic attribution, not a private label.
5. **Prove it.** Extend `supabase/tests/analytic_accounting_contract_test.sql`: a project insert provisions exactly one analytic account; a bill line tagged only with a project posts a JELA row against that account; a void produces a contra row netting to zero; no JELA row crosses a company.

## Then, in order

- **Phase 5 — Consumers.** Exactly three reports through `reportDataEngine` + `ReportRegistry`: Analytic Account Statement (drill to JE), P&L by Analytic Account, Budget vs Actual by Analytic Account. Server-side, period- and branch-aware, each tying out to the GL.
- **Phase 6 remainder.** Architecture test forbidding client-side analytic aggregation, plus one live post/void round trip once real analytic postings exist.

Explicitly out of scope (do not build): user-defined unlimited dimensions, a separate analytic budget engine, stored analytic balances, statistical postings without a GL counterpart, automatic distribution-rule engines.

## Standing rules

Aggregation stays server-side — the client selects an axis, the database computes amounts. No orphaned UI fields, no half-wired producers, no second book of record. A phase marked Done that fails verification is reopened, not layered on. Update this file at the end of the work so it stays authoritative.
