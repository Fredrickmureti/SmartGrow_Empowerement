# Cash & Banking Reporting — Authoritative Status (2026-08-20, late)

Legend: **[FACT]** verified this session · **[TASK]** pending work

Related history: `.lovable/plan/cash-banking-reporting-investigation-findings-and-phased-pla-2026-08-20.md`,
`.lovable/plan/cash-banking-reporting-handover-verification-and-continuatio-2026-08-20.md`,
`.lovable/plan/cash-banking-reporting-verification-continuation-2026-08-21-2026-08-20.md`.

## Currently active phase

**Phase 6 — Cash & Banking dashboard coherence: COMPLETE.**
Phases 0–5 are complete and verified. **Next: Phase 7 — the cash position as of a date
(dashboard/report agreement across time), see "Pending work".**

## Fully implemented and verified

### Phase 1 — Security (complete)
- **[FACT]** `finance_can_read_org(_org_id)` gates `get_account_movements`, `get_general_ledger`,
  `get_account_balances`, `get_gl_transactions`, `get_account_balance_at_date`,
  `check_balance_integrity`, `get_control_account_reconciliation`,
  `finance_cash_flow_statement`, `finance_bank_reconciliation_statement`. All SECURITY DEFINER,
  pinned `search_path=public`, no `PUBLIC`/`anon` EXECUTE (re-verified against `pg_proc` /
  `has_function_privilege` this session).

### Phase 2 — Cash Flow, one engine (complete)
- **[FACT]** `finance_cash_flow_statement` is the single engine: screen via
  `src/services/finance/cashFlow.ts`, PDF/schedule via
  `supabase/functions/_shared/reportDataEngine.ts`. Residual proved 0.00 on live data.

### Phase 3 — Bank Reconciliation Statement (complete)
- **[FACT]** `finance_bank_reconciliation_statement(_org_id, _bank_account_id, _as_of,
  _business_id, _branch_id)` returns the classic two-sided proof plus item drill-downs and
  diagnostics (`gl_account_missing`, `gl_account_shared`, `cleared_without_posting`,
  `gl_currency_fallback_lines`). Single-currency by construction; a shared control account nulls
  the book side rather than mis-attributing movement.
- **[FACT]** `src/pages/reports/BankReconciliationReport.tsx` renders the payload verbatim and
  performs no accounting arithmetic.

### Phase 4 — Session register cleanup (complete)
- **[FACT]** Second tab of the same screen; cross-currency money KPIs replaced by counts;
  registry entry filed under `cash_bank`.

### Phase 0 — Report row-kind type defects (complete)
- **[FACT]** `BankReconciliationReport.tsx` used `tone` for structural row meaning; replaced with
  the real `kind` values (`subsection`, `subtotal`, `calculatedResult`). Typecheck clean.

### Phase 5 — Export coherence: the PDF states the same proof as the screen (complete)
- **[FACT]** `buildBankReconciliation` in `_shared/reportDataEngine.ts` is a pure projection of
  the RPC — no queries, no arithmetic. A null book side (missing or shared GL account) renders as
  "not stateable", never as zero. Outstanding items are projected in full for audit.
- **[FACT]** `render-report` knows `bank_reconciliation` (bank account taken from
  `filters.bankAccountId`), and `buildReportData` now carries `branchId` + `filters` — previously
  branch was silently dropped, so a branch-scoped screen exported a company-wide PDF.
- **[FACT]** `CashFlowReport.tsx` was missing `organizationId` / `dateFrom` / `dateTo`, so
  `canServerBuild` was false and every export re-shipped the browser's rows instead of the engine.
  Fixed; both pages now declare `ServerBuildConfig`.
- **[FACT]** `columnSpecs.ts` carries a `bank_reconciliation` statement-profile spec.
- **[FACT]** `process-scheduled-reports` passes `undefined` for branch **deliberately**:
  `scheduled_reports` has no branch column, so a scheduled run is business-wide by definition.
- **[FACT]** Guards: `src/test/architecture/report-export-coherence.test.ts` (10),
  `cash-banking-category-coherence.test.ts` (3). SQL proof:
  `supabase/tests/bank_reconciliation_statement_proof_test.sql` (each side's arithmetic,
  adjusted bank − adjusted book = residual, group totals tie to listed items). It must be run as
  `service_role`; it skips loudly rather than passing vacuously when EXECUTE is denied.

### Phase 6 — Cash & Banking dashboard coherence (complete, this session)
- **[FACT]** Defect found and fixed: `src/pages/Banking.tsx` computed its own cash figure as
  `accounts.opening_balance + posted-JE movement` via `useAccountBalances.getEffectiveBalance`.
  When an opening balance has itself been posted as a journal entry (the normal case — see the
  live finding below) that **double counts the opening balance**, and it ignored the shared
  control account case entirely. The Banking overview could therefore state a different cash
  position from the reconciliation statement for the same account on the same day.
- **[FACT]** The page now reads `resolveBankAccountBalance(account)` over
  `bank_account_positions()` — the same projection the account cards use. It performs no
  balance arithmetic; `useAccounts` / `useAccountBalances` are gone from the page.
- **[FACT]** An account whose balance does not resolve (no GL link, shared control account, or
  no statement line) is **excluded from the total and disclosed on the KPI**, never counted as
  zero. FX conversion still refuses the total outright when a rate is missing (ADR-0136).
- **[FACT]** `BankAccountCard` lost its `glBalance` prop: a caller-supplied override was a second
  way to answer "how much money is in this account". It now discloses `gl_shared`.
- **[FACT]** Per-card unreconciled count comes from the same projection, so the card's two
  numbers share one `as_of`.
- **[FACT]** Guards extended in `src/test/architecture/banking-balance-provenance.test.ts`
  (8 tests). Whole cash & banking guard suite: 57 tests green. Typecheck clean.

## Live-data finding to hand to the business (not an engine defect)

- **[FACT]** Org "Joshua Holdings", account "Test Operating Bank – KES": unexplained difference
  of **−50,000.00 KES** as at 2026-08-20. The bank ledger account carries the opening balance
  **twice** — once via `bank_accounts.opening_balance_je_id` (2026-08-01) and once via a separate
  posted entry behind the 2026-07-31 "Opening balance" statement line. The duplicate posting must
  be reversed in the data; no code change will make it disappear honestly.

## Pending work

### Phase 7 — The cash position as of a date (next)
- **[TASK]** `bank_account_positions(_business_id, _as_of)` defaults `_as_of` to `CURRENT_DATE`
  and the dashboard never passes one, while the reconciliation statement is always as of a chosen
  date. Give the Banking overview an explicit as-of (defaulting to today) and pass it through, so
  "dashboard vs statement" disagreements are impossible to manufacture by date drift.
- **[TASK]** `bank_account_positions` is **not** SECURITY DEFINER and has no
  `finance_can_read_org` gate — it relies entirely on RLS on `bank_accounts` /
  `journal_entry_lines`. Verify that reliance is sound (query as a foreign-org member and prove
  zero rows) and, if it is not, bring it onto the same gate as the reporting RPCs. Do not assume;
  prove it with a query before changing anything.
- **[TASK]** Add the positive SQL leg for `bank_account_positions` to `supabase/tests/`.

### Phase 8 — Scheduled/branch dimension (deferred, needs a migration)
- **[TASK]** `scheduled_reports` has no `branch_id`. Until it does, a scheduled cash flow cannot
  be branch-scoped. Either add the column + UI, or state the business-wide scope on the delivered
  document so the recipient is not misled.

### Unresolved policy (documented, not blocking)
Whether cash equivalents are `cash_flow_category='cash'` only, or must also include POS /
credit-card / undeposited-funds clearing accounts. Default stands: `'cash'` only.

## Instructions for the next agent

1. **Verify Phase 5 and Phase 6 before extending anything.**
   a. `bunx vitest run src/test/architecture/banking-balance-provenance.test.ts
      src/test/architecture/report-export-coherence.test.ts
      src/test/architecture/cash-banking-category-coherence.test.ts
      src/test/architecture/bank-reconciliation-single-engine.test.ts
      src/test/architecture/cash-flow-single-engine.test.ts
      src/test/architecture/reporting-isolation-matrix.test.ts` — expect 8/10/3/5/6/11 green.
   b. `tsgo --noEmit -p tsconfig.app.json` — expect silence.
   c. Read `src/pages/Banking.tsx`: it must contain no balance arithmetic and no
      `useAccountBalances`.
   d. With a **service_role** harness, on one real account: call
      `finance_bank_reconciliation_statement` and `bank_account_positions` for the same date and
      confirm the book side agrees with the account's `gl_balance`; then render the
      `bank_reconciliation` PDF through `render-report` and confirm the PDF's figures equal the
      screen's. That end-to-end equality is the actual claim of Phase 5 and it has only been
      proved structurally (by guards), not yet on rendered output.
2. The repo has ~111 pre-existing failing test files unrelated to this domain (e.g.
   `wms-rpc-grants`). Do not attribute them to this work and do not start fixing them here.
3. Then resume at **Phase 7**, top task first. Stay in Cash & Banking; do not leave the dashboard
   and the statement able to disagree about the same account on the same day.

4 Kindly Note, reconcilaition engine needs to be scrutnized heavily for example, what happens if there is bad reconciliaion on a transaction, can it be unreconciled properly and professioanlly like other enterprise systems, for example in Bank reconciliatin repors there is a message (Statement does not reconcile
An unexplained difference of -50000.00 KES remains after outstanding and unrecorded items. Investigate duplicate or missing postings before closing the period.)   THE SYSTEM SHOULD BE ABLE TO TELL THE ACCOUNTANT WHAT TO DO, QUICK SMART SUGGESTIONS  AND WHAT TO DO NEXT FOR EXAMPLE THERE IS ALSO THE SESSIONS TAB WITH ACTION BUTTON OF OPEN WHICH WHEN USERS CLICK OPEN THEY ARE TAKEN TO THE ABNK RECONCILIATON BUT there is nowhere we jave the sessions from which they ahve been redirected from to the bank reconciliaon page , the reconciliaion should be context aware, no room for an error , Ultra smart suggestions, do not do shallow things or assume things, carefully scrutmize every aspect of the reconciliation engine and make sure its doing whats its meant to be , look at reconcolaion engine and everything it relates to from abnk feeds etc carefully and logically look at them, analzy even the rules one by one, break it into many steps/phases )
