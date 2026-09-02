# Smart Grow Empowerment — handoff

Plan of record: `.lovable/plan/smart-grow-empowerment-microfinance-convergence-plan-reworke-2026-09-02.md`
Live status: `.lovable/microfinance-status.md`

Backend: Supabase `xwxqunklduknceoryrha` — already connected. No second project.

## State

- C1–C8b done; **V1 live lifecycle proof PASS** (application → assessment →
  approval → loan + schedule → disburse → repay → reverse → top-up →
  successor disbursement → predecessor closure, all journals balanced).
- **C9 reports DONE and verified**: portfolio, arrears & PAR, collections,
  disbursements — built on the inherited report engine, registered in the
  registry under a new `lending` domain, routed at `/lending/reports/*`, with
  an "Insights" nav group. Typecheck clean; all four report architecture
  guards pass (64/64).

## Remaining

1. **C9 documents** — loan agreement, repayment schedule, loan statement,
   payment receipt on the existing document engine (institution settings
   injected; no new renderer or PDF path).
2. **C10** — `mf_*` RLS/grants hardening + security scan, then the single bulk
   ERP removal sweep: POS/retail, inventory, warehouse, procurement,
   order-to-cash, CRM, payroll, attendance, and the non-retained finance
   surfaces (keep chart of accounts, journals, fiscal periods, fixed assets,
   reports, settings).

## Rules

Reuse only the document engine, auth engine, navigation/UI foundation, and
Finance strictly as the posting target. Financial state is derived
server-side. Every domain action is an append-only event with a
mapping-resolved accounting hook. Never fix, explore or document an ERP
surface that is on the C10 delete list. No speculative work; optimise for
scope discipline and credit efficiency.



=============THIS WAS THE LAST MESSAGE IT GAVE BEFORE ITS TIME RUN OUT======


Stopped before making changes this turn — nothing was edited, so the repo is exactly as it was after C9 reports landed.

Where things stand and what remains for C9 documents:

- The document engine is template-AST driven: a new document kind needs (1) a `document_kinds` row, (2) a system-scope `document_template_ast` row pinning a `layout`, (3) a dedicated PDF layout module registered in `supabase/functions/_shared/rendering/renderers/pdf.ts` (the commercial invoice renderer will refuse non-commercial kinds), and (4) a client snapshot builder plus a registry entry in `src/services/documents/resolveSourceDocumentRecord.ts`.
- Planned kinds: `lending.loan_agreement`, `lending.repayment_schedule`, `lending.loan_statement`, `lending.payment_receipt` — the first three on one new `pdf/layouts/lending.ts` module (agreement = prose + schedule table, schedule = table, statement = ledger style), the receipt reusing the receipt path.
- Then wire preview/download/print actions on the loan and repayment screens, and update `.lovable/microfinance-status.md`.

Next session should start by writing the lending PDF layout module and the kinds/templates migration together, then the snapshot builders.


NOTE
=============
And kindly note: **there is absolutely no room for unnecessary work or credit wastage here.** We need to be highly deliberate about scope.

The objective is to **strip away everything the microfinance system does not need** and immediately create a clean foundation for its business logic. Do not preserve unnecessary ERP complexity simply because it already exists.

What we want to **reuse** from the existing system is specifically:

* **Document generation engine**
* **Authentication/auth engine**
* **Navigation and UI foundation**

Everything else should be evaluated critically. If a component, module, workflow, table, dependency, or business rule is not required by the microfinance system, **remove it, disable it, or leave it out of the new scaffold** rather than carrying unnecessary complexity forward.

The client does **not** need another complicated ERP. We are building a focused microfinance platform, so the architecture should be lean, intentional, and optimized around the actual business requirements.

**Do not waste credits exploring or rebuilding things we already know we will not use.** Make the necessary architectural decisions quickly, clear the unnecessary ERP scaffolding, preserve only the reusable foundation, and open the way for us to start implementing the **actual microfinance business logic immediately.**

**Optimize for speed, relevance, and credit efficiency. No unnecessary work.**
