# Smart Grow Empowerment — handoff (2026-09-02)

Plan of record: `.lovable/plan/smart-grow-empowerment-microfinance-convergence-plan-reworke-2026-09-02.md`
Live status: `.lovable/microfinance-status.md`

Backend: Supabase `xwxqunklduknceoryrha` — already connected. No second project.

## State

C1–C8b done. **V1 live lifecycle proof: PASS** — application → assessment →
approval → loan + schedule → disburse → repay → reverse → top-up → successor
disbursement → predecessor closure, all journal entries balanced, zero
unbalanced entries. Microfinance accounting is now proven, not just coded.

Fixed this pass: application `ready_for_disbursement → disbursed` transition +
status check constraint, and `mf_loans.application_id` made nullable for
top-up/restructure successors. Temporary proof helpers dropped.

## Remaining

1. **C9** — microfinance reports + documents registered on the inherited
   report/document engines (no new renderer, institution settings injected).
2. **C10** — hardening (RLS/grants on `mf_*` only, security scan) plus the
   single bulk ERP removal sweep: POS/retail, inventory, warehouse,
   procurement, order-to-cash, CRM, payroll, attendance, and the non-retained
   finance surfaces. The ~3,675 inherited linter findings are addressed there —
   none originate in `mf_*`.

## Rules (unchanged)

Reuse only the document engine, auth engine, navigation/UI foundation, and
Finance strictly as the posting target. Financial state is derived server-side.
Every domain action is an append-only event with a mapping-resolved accounting
hook. Never fix, explore or document an ERP surface that is on the C10 delete
list.
