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
