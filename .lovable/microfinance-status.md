# Microfinance convergence — live status (2026-09-02)

Plan of record: `.lovable/plan/smart-grow-empowerment-microfinance-convergence-plan-reworke-2026-09-02.md`

Done: C1–C8a, C6b accounting hook, C7/C7b repayments + arrears + collections.

C8b top-up / restructure — **complete**:
- backend (pre-existing): `mf_reissue_loan`, loan lineage columns, successor
  settlement posting in `mf_disburse_loan`, `loan_settled_by_successor` treatment.
- frontend (this pass): `reissueLoan` mutation in `useMfLoans` (invalidates loans,
  schedule, balances, events); Top up / Restructure actions in
  `LoanLifecycleDialog` (reason required, additional principal only for top-up,
  revised term/rate/first-due); lineage shown on `LoansPage`
  ("Top-up of X" / "Replaced by Y"); actions hidden once a loan is replaced.
- Note: mf loan products carry no `allow_topup`/`allow_restructure` flags, so
  eligibility is enforced server-side by `mf_reissue_loan` role/state guards only.

Next: **V1** — one live disburse → repay → reverse → top-up → close cycle against
the live database, confirming journal balance vs `mf_loan_balances`. Then C9
(reports + documents on the inherited engines), then C10 (hardening + single ERP
removal sweep).
