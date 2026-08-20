# Cash & Banking Reporting — Authoritative Status (2026-08-20)

Legend: **[FACT]** verified this session · **[TASK]** pending work

Related history: `.lovable/plan/cash-banking-reporting-investigation-findings-and-phased-pla-2026-08-20.md`,
`.lovable/plan/cash-banking-reporting-handover-verification-and-continuatio-2026-08-20.md`.

## Currently active phase

**Phase 3 — Bank Reconciliation Statement: COMPLETE.** Phase 4 (session register cleanup) was
folded into the same screen and is complete. **Next: Phase 5 — Cash & Banking category coherence.**

## Fully implemented and verified

### Phase 1 — Security (complete)
- **[FACT]** `finance_can_read_org(_org_id)` gates `get_account_movements`, `get_general_ledger`,
  `get_account_balances`, `get_gl_transactions`, `get_account_balance_at_date`,
  `check_balance_integrity`, `get_control_account_reconciliation`. All definer, pinned
  `search_path`, no `anon` EXECUTE. The cross-tenant GL leak is closed.

### Phase 2 — Cash Flow, one engine (complete)
- **[FACT]** `finance_cash_flow_statement` is the single engine. The screen reads it through
  `src/services/finance/cashFlow.ts`; the PDF/schedule path reads it through
  `supabase/functions/_shared/reportDataEngine.ts` (the old name-matching heuristic is deleted).
- **[FACT]** Proved on live data with a service-role harness: residual 0.00 across several windows
  and business scopes.
- **[FACT]** Guards: `src/test/architecture/cash-flow-single-engine.test.ts`,
  `reporting-isolation-matrix.test.ts`, `supabase/tests/reporting_isolation_matrix_test.sql`.

### Phase 3 — Bank Reconciliation Statement (complete)
- **[FACT]** `finance_bank_reconciliation_statement(_org_id, _bank_account_id, _as_of,
  _business_id, _branch_id)` — definer, pinned `search_path`, `finance_can_read_org` gate,
  EXECUTE revoked from `PUBLIC`/`anon`, granted to `authenticated` + `service_role`.
  It returns the classic proof: statement balance → deposits in transit → unpresented payments →
  adjusted bank balance; ledger balance → unrecorded receipts → unrecorded charges → adjusted book
  balance; plus the residual, item drill-downs (capped at 200 with a truncation flag) and
  diagnostics (`gl_account_missing`, `gl_account_shared`, `cleared_without_posting`,
  `gl_currency_fallback_lines`, latest session).
- **[FACT]** Single-currency by construction: ledger lines use `original_*` amounts when the entry
  carries the bank account's currency, so no FX noise enters the proof. A ledger account shared by
  two open bank accounts nulls the book side rather than mis-attributing movement.
- **[FACT]** Opening-balance correctness: the opening balance counts only from its own
  `opening_balance_date`, statement lines it already contains are not double counted, and an entry
  tied to any statement line of the account is never reported as an outstanding item.
- **[FACT]** Client seam `src/services/finance/bankReconciliationStatement.ts` is the only caller.
  `src/pages/reports/BankReconciliationReport.tsx` renders the payload verbatim (Statement tab)
  and performs no accounting arithmetic.
- **[FACT]** Guard `src/test/architecture/bank-reconciliation-single-engine.test.ts` (5 tests) plus
  the new entries in both isolation matrices — all green.

### Phase 4 — Session register cleanup (complete)
- **[FACT]** The register is the second tab of the same screen: `reconciled_balance` relabelled
  "Cleared Movement", a Currency column added, and the meaningless cross-currency money KPIs
  replaced by counts (total / open / completed / with a difference).
- **[FACT]** Registry entry moved from `audit` to `cash_bank` and renamed "Bank Reconciliation".

## Live-data finding to hand to the business (not an engine defect)

- **[FACT]** Org "Joshua Holdings", account "Test Operating Bank – KES": the statement shows an
  unexplained difference of **−50,000.00 KES** as at 2026-08-20. The bank ledger account carries the
  opening balance **twice** — once via `bank_accounts.opening_balance_je_id` (2026-08-01) and once
  via a separate posted entry behind the 2026-07-31 "Opening balance" statement line. Earlier engine
  drafts hid this by counting the second posting as a deposit in transit; the statement now reports
  it. The duplicate posting should be reversed in the data.

## Pending work

### Phase 5 — Cash & Banking category coherence (next)
- **[TASK]** Add a registry test asserting `cash_bank` membership (cash flow statement, bank
  reconciliation, bank/cash dashboards) so the taxonomy cannot silently drift.
- **[TASK]** Route `render-report` for `reportType: "bank-reconciliation"` through
  `finance_bank_reconciliation_statement` so the PDF states the same proof as the screen — the exact
  defect Phase 2b fixed for cash flow. **This is the highest-value remaining item.**
- **[TASK]** Add the SQL-side positive test for the new RPC (own-org call succeeds, foreign-org
  raises 42501) to `supabase/tests/`; only the foreign-org leg exists today.

### Unresolved policy (documented, not blocking)
Whether cash equivalents are `cash_flow_category='cash'` only, or must also include POS /
credit-card / undeposited-funds clearing accounts. Default stands: `'cash'` only.

## Instructions for the next agent

1. **Verify before extending.** Confirm: (a) `finance_bank_reconciliation_statement` is definer +
   gated + no `anon` EXECUTE; (b) the report page contains no accounting arithmetic; (c)
   `bunx vitest run src/test/architecture/bank-reconciliation-single-engine.test.ts
   src/test/architecture/reporting-isolation-matrix.test.ts
   src/test/architecture/cash-flow-single-engine.test.ts` is green; (d) call the RPC with a
   service-role harness on a real account and check that
   `adjusted_bank − adjusted_book = residual` and that the item lists explain the difference.
2. Note: the repo has ~111 pre-existing failing test files unrelated to this domain (e.g.
   `wms-rpc-grants`). Do not attribute them to this work, and do not start fixing them here.
3. Then resume at **Phase 5**, top task first (the export path). Do not jump to another domain and
   do not leave the export stating a different proof from the screen.
