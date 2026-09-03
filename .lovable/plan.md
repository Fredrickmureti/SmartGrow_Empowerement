# Smart Grow Empowerment — microfinance platform (status of record)

Backend: Supabase `xwxqunklduknceoryrha` (already connected, holds the `mf_*` domain).
Approved plan: `.lovable/plan/smart-grow-empowerment-microfinance-platform-plan-of-record-2026-09-03.md`.

## C9 — Lending documents: DONE (2026-09-03)

- `src/apps/lending/documents/LendingDocumentsMenu.tsx` — the single lending output affordance. Preview goes through the app-wide `DocumentPreviewProvider` (render-only), download through `downloadExport` (same frozen snapshot). No new renderer, no new PDF path.
- `LoansPage` rows: Documents menu → loan agreement, repayment schedule, loan statement.
- `RepaymentsPage` rows: Receipt menu → payment receipt.
- Engine side was already in place and re-verified: `LENDING_LAYOUTS` dispatched in `supabase/functions/_shared/rendering/renderers/pdf.ts`, four `lending.*` `document_kinds` rows + 4 template AST rows in the live DB, registry entries in `resolveSourceDocumentRecord.ts`.

Gate: `tsgo --noEmit` clean; dev server restarted (cleared a stale pre-existing `@tanstack/router-core` module-graph error unrelated to this work); `/lending/loans` and `/lending/repayments` both return 200. A live per-kind PDF render could not be executed from the sandbox — the Supabase project is external/unmanaged, so no session can be minted here. Render each kind once from a signed-in browser session to close that check.

## Next: C10 — single bulk ERP removal sweep

One pass, no per-module investigation. Delete apps/routes/nav/pages/hooks/services/tests for: HR app (keep user + role + branch assignment in Settings/Team), ERP contacts app, budgets, consolidation, customer statements/credits, compliance/fiscal-compliance workspaces, BI page, and all sales / purchase / inventory / warehouse / POS / payroll / attendance remnants plus their edge functions (`etims-*`, `paypal-*`, `pesapal`, `process-recurring-invoices`, `generate-statutory-return`, tax-certificate, filing-calendar). Keep `mpesa-*`.

Finance registry after the sweep: Chart of Accounts, Journal Entries, Fiscal Periods, Fixed Assets, Banking, Bank Feeds, Bank Reconciliation, Receivables, Payables, Reports, Settings.

Gate: tsgo clean, build OK, sidebar shows only Dashboard / Lending / Finance / Reports / Settings, every surviving route renders.

Then C11 (retailor banking + AR/AP to microfinance) and C12 (hardening), per the approved plan.

## Rules (binding)
1. Financial state is derived server-side; React never owns balances, interest, arrears, allocations or journal amounts.
2. Append-only events with mapping-resolved postings; history is never edited.
3. One object per migration; GRANTs + RLS in the same migration.
4. A bug in a C10 delete-list surface is not a bug.
5. Reuse before rebuild — retailor working Finance/banking/settlement engines, never re-implement them.
6. Each milestone ends with: tsgo clean, build OK, affected screens rendered, this file updated in place.


=============THIS WAS THE LAST MESSAGE IT GAVE BEFORE ITS TIME RUN OUT======


The Supabase project `Smart Grow Empowerment` (ref `xwxqunklduknceoryrha`) is already connected — nothing to reconnect. I'll verify the current state quickly, then execute the remaining milestone (C10 sweep).

Work paused mid-sweep (credits exhausted). Here's exactly where things stand so the next session can resume without re-investigation.

Supabase: `Smart Grow Empowerment` (`xwxqunklduknceoryrha`) was already connected — nothing to do there.

C10 sweep — done so far (uncommitted edits in the working tree):
- `src/lib/apps/registry.ts` rewritten: only Home / Lending / Finance / Reports / Studio / Settings remain; Contacts, Employees/HR, My Workspace, budgets, customer credits/statements, consolidation, BI, migration and compliance modules removed.
- `src/App.tsx`: `/hr/*`, `/contacts-app/*`, `/me/*`, `/compliance*`, `/settings/{compliance,carriers,migration}`, print-latency diagnostic and consolidation redirects removed; `-lazyRoutes.tsx` trimmed to Studio + Audit Logs.
- `src/apps/finance/routes.tsx` + `nav.ts`: customer/vendor credits, budgets, analytic accounts, consolidation, tax, BI, partner ledger, budget/analytic reports, POS/contact redirects removed.
- `src/services/reports/ReportRegistry.ts`: 13 ERP report entries removed; receivables/payables relabelled.
- Deleted: `src/apps/{hr,contacts,me}`, `src/pages/{hr,me,contacts}`, `src/features/{hr,contacts}`, `features/finance/{budgets,customer-credits,analytic-accounts}`, ~25 ERP pages, 27 ERP edge functions (`mpesa-*` kept). `src/apps/index.ts` and `appOptions.ts` updated.

Remaining to close C10 (in order):
1. Fix 4 broken imports: delete `src/components/hr/ManagerTriageBanner.tsx` (and its callers) and `src/test/architecture/nav-app-coherence.test.ts`; the `styles.css?url` warning is pre-existing/benign.
2. Dead-code pass: reachability scan found 542 unreachable files — biggest clusters are `src/hooks` (136), `src/components/employees` (38), `src/hooks/hr` (24), `components/{migration,hr,contacts,payments,me}`, `lib/{importConfigs,hr,migration,inventory,gs1,receipt,purchases}`. Delete by cluster, re-run the scan, repeat.
3. Delete tests that reference removed surfaces; run `tsgo --noEmit`, check `build-errors.log`, then render `/dashboard`, `/lending/*`, `/finance/*`, `/settings` and confirm the sidebar shows only Dashboard / Lending / Finance / Reports / Settings.
4. Update `.lovable/plan.md` (C10 → DONE, next = C11 banking/AR/AP retailoring).

Note: the tree is currently mid-change and may not build until step 1 is done.

NOTE
=============
And kindly note: **there is absolutely no room for unnecessary work or credit wastage here.** We need to be highly deliberate about scope.

The objective is to **strip away everything the microfinance system does not need** and immediately create a clean foundation for its business logic. Do not preserve unnecessary ERP complexity simply because it already exists.

What we want to **reuse** from the existing system is specifically:

* **Document generation engine**
* **Authentication/auth engine**
* **Navigation and UI foundation**
* *Banking and reconciliation , payables receivables but now tailored for microfinance**
TO BE PRECISE, WHAT IS REUSABLE, KINDLY REUSE IT INCLUDING PAYMENT SETTLEMENT ENGINE FOR PAYABELES/RECEIVABLES, basically accross the Finance what is reusable use it as long as its microfuiannce tailored because we are building mciro fianance  if its statements instead of customer staments lest it be  talowred towards microfinance not the current sales oriented that was used by the old erp so dont just delete what is reusable and has solid engine that will be painful to rebuild from scratch, reason like a mircofiannce system developer not like a blind bot

Everything else should be evaluated critically. If a component, module, workflow, table, dependency, or business rule is not required by the microfinance system, **remove it, disable it, or leave it out of the new scaffold** rather than carrying unnecessary complexity forward.

The client does **not** need another complicated ERP. We are building a focused microfinance platform, so the architecture should be lean, intentional, and optimized around the actual business requirements.

**Do not waste credits exploring or rebuilding things we already know we will not use.** Make the necessary architectural decisions quickly, clear the unnecessary ERP scaffolding, preserve only the reusable foundation, and open the way for us to start implementing the **actual microfinance business logic immediately.**

**Optimize for speed, relevance, and credit efficiency. No unnecessary work.**
