# Cash & Banking Reporting — Investigation Findings and Phased Plan

Labels: **[FACT]** verified in code/DB this session · **[RESEARCH]** external practice · **[INFER]** reasoned, not proven · **[REC]** recommendation · **[TASK]** implementation · **[TEST]** test requirement

## 1. Current state (verified)

- **[FACT]** The `cash_bank` category contains exactly **one** report: `cash-flow` (`ReportRegistry.ts:216-228`). "Bank Reconciliation Report" is registered under category `audit` (`ReportRegistry.ts:364-374`). The premise "the category contains two reports" is false at the registry level; they are only linked by a related-report pair (`:746`).
- **[FACT]** Cash Flow: hook `src/hooks/useCashFlowReport.ts` + page `src/pages/reports/CashFlowReport.tsx`. There is **no service and no server-side report RPC**. The hook calls the generic `get_account_movements` RPC twice (period + all prior) and performs *all* statement logic in React: account classification, net income, working-capital deltas, section totals, opening cash.
- **[FACT]** Classification is account-based via `accounts.cash_flow_category`, with a `detail_type`/`account_type` heuristic fallback hardcoded in the hook (two literal arrays of detail types).
- **[FACT]** Bank Reconciliation Report: page-only (`src/pages/reports/BankReconciliationReport.tsx`), a plain PostgREST list of `bank_reconciliation_sessions` joined to `bank_accounts`. No hook, no service, no RPC.
- **[FACT]** The reconciliation engine is genuine and authoritative: `_bank_reconciliation_recompute(session)` is the single writer of `reconciled_balance`/`difference`, computed from `_bank_account_movement(bank_account, statement_date, session)` plus service charge, interest and write-off; `_bank_reconciliation_gl_tieout(session)` returns `gl_account_id, cleared_movement, gl_movement, divergence, cleared_without_posting`.
- **[FACT]** `journal_entry_lines.debit/credit` are base-currency; transaction currency lives in `original_currency/original_debit/original_credit/exchange_rate`. GL-sourced cash reporting is therefore currency-safe; bank-account-sourced reporting is not automatically so.
- **[FACT]** `bank_account_positions()` is the canonical server projection for bank balances, and an architecture test (`banking-balance-provenance.test.ts`) forbids untraceable bank balances. The reconciliation report does not use it.
- **[FACT]** Neither cash nor bank reporting appears in the isolation guards (`src/test/architecture/reporting-isolation-matrix.test.ts`, `supabase/tests/reporting_isolation_matrix_test.sql`); those cover only the receivables/sales/purchases RPC family.

## 2. Security findings

- **[FACT] CRITICAL — cross-tenant GL leak.** `get_account_movements(_org_id, ...)` is `SECURITY DEFINER`, is EXECUTE-able by `authenticated` (verified via `has_function_privilege`), and validates only that the passed business/branch belong to the passed org. **It never checks that the caller is a member of `_org_id`** (no `_assert_org_member`, no `user_business_access` predicate). Any signed-in user of any tenant can call it with another organization's id and receive per-account posted debit/credit totals — i.e. that tenant's entire GL activity shape, including cash and bank accounts. Definer status bypasses RLS.
- **[FACT]** Blast radius beyond Cash Flow: `src/services/gl/fetchGLTotals.ts`, `src/hooks/useYearEndClosing.ts`, `src/hooks/useDashboardStats.ts` use the same RPC.
- **[FACT]** Bank Reconciliation Report relies on table RLS (`organization_id IN get_user_organizations(auth.uid())`) — structurally sound, but unproven by any isolation test, and its branch filter uses the widening `branch_id.eq.X,branch_id.is.null` OR pattern.
- **[INFER]** No evidence of a leak via the reconciliation page; do not assume the Cash Flow defect generalises to it.

## 3. Accounting findings

### Cash Flow Statement
- **[FACT]** `closingCash = openingCash + netCashFlow` is assigned, not derived. Closing cash is never computed independently from the cash accounts' ledger balance, so the statement **cannot fail** its own reconciliation and any misclassification is invisible. **[RESEARCH]** IAS 7 requires the statement to reconcile to the actual cash and cash equivalents balance in the balance sheet.
- **[FACT]** `openingCash` mixes `accounts.opening_balance` with prior-period GL movements. If an opening balance was also posted as a journal entry (the bank engine has `_bank_account_post_opening_balance`), opening cash is double-counted.
- **[FACT]** Any account whose `cash_flow_category` is null and whose `detail_type` is not in the hardcoded fixed-asset list falls into "Other current assets". A bank/cash account missing the `cash` category is therefore both excluded from cash *and* treated as working capital — a two-sided error.
- **[FACT]** No "effect of exchange rate changes on cash" line (IAS 7 ¶28); FX revaluation of foreign-currency cash lands inside net income with no add-back, breaking the true reconciliation once it is enforced.
- **[FACT]** Investing = net GL movement of fixed-asset accounts, which includes non-cash additions (finance leases, revaluations, accrued purchases, disposals at NBV). **[RESEARCH]** Non-cash investing/financing must be excluded from the statement.
- **[FACT]** Depreciation add-back uses `Math.abs()` of the movement, so a disposal reversing accumulated depreciation is added back as if it were an expense.
- **[FACT]** Client-side computation contradicts the server-owned pattern established for sales/purchase analysis and means UI, export and any future PDF re-derive the numbers in the browser.

### Bank Reconciliation Report
- **[FACT]** It is a **register of reconciliation sessions**, not a bank reconciliation statement. It shows opening / statement close / "Reconciled" / difference.
- **[FACT]** The column labelled "Reconciled" renders `reconciled_balance`, which the engine defines as a **movement** (cleared net ± charges/interest/write-off), not a balance. The KPI "Reconciled balance (completed)" sums those movements across accounts **and across currencies**, and formats the result in base currency while the underlying values are in account currency. Two verified defects: wrong semantics, wrong currency.
- **[FACT]** `difference` is displayed as a single number with no breakdown; the engine's richer truth (`_bank_reconciliation_gl_tieout`: GL divergence, `cleared_without_posting`) is computed but never surfaced anywhere in reporting.
- **[FACT]** The report shows no book/GL balance, no outstanding deposits, no outstanding payments, no adjusted bank balance, no adjusted book balance, and no drill-down to statement lines.
- **[RESEARCH]** NetSuite splits this into a Reconciliation **Summary** (cleared/uncleared balances per item class) and a Reconciliation **Detail** (transactions by type for the statement period). Odoo/OCA's bank reconciliation report presents: accounting balance of the bank account → journal items not linked to statement lines → statement lines not linked to journal items → computed balance at the bank. Both are per-account, per-date statements — not session lists.

## 4. Target model (recommendation)

**[REC]** Cash & Banking should hold three distinct artefacts, with clean separation of kind:

| Artefact | Kind | Question answered | Authoritative source |
|---|---|---|---|
| Cash Flow Statement | Financial statement | How did cash move between opening and closing? | Posted GL only, server-computed |
| Bank Reconciliation Statement (per account, as-of date) | Reconciliation report | Does the bank agree with the books, and what explains the gap? | Reconciliation engine + `bank_account_positions` + GL tie-out |
| Bank Reconciliation Sessions | Register | Which reconciliations exist, and are any drifting? | `bank_reconciliation_sessions` (today's page, correctly renamed) |

**[REC]** Do **not** add a "Cash Ledger", "Bank Register" or "Undeposited Funds" report: the General Ledger + Partner Ledger + drill-down already answer those questions per account. Revisit only after the two statements above are correct.

**[REC] Unresolved policy (documented, not blocking):** whether cash equivalents are defined by `cash_flow_category='cash'` alone or must also include specific `detail_type`s (POS/credit-card/undeposited-funds clearing). Phase 2 will make the definition explicit and DB-driven; the default proposal is `cash_flow_category='cash'` only, with clearing accounts treated as operating working capital.

## 5. Phased plan

### Phase 1 — Security (first and only phase to implement now)
- **[TASK]** Add a caller-membership gate to `get_account_movements` (`_assert_org_member(_org_id)` as the first statement), keeping existing business/branch ownership checks. Migration only; no signature change, so all four callers are unaffected.
- **[TASK]** Audit sibling GL RPCs used by finance reports (`get_account_balances`, `get_account_balance_at_date`, `get_general_ledger`, `get_gl_transactions`, `get_control_account_reconciliation`) for the same missing caller gate; fix each that is missing it in the same migration. Do not assume they share the defect — check each `pg_proc` body first.
- **[TASK]** Extend both isolation guards to cover the cash & banking surface: add the audited GL RPCs to `REPORTING_RPCS` in `reporting-isolation-matrix.test.ts` and to `_reporting_matrix` in `reporting_isolation_matrix_test.sql`.
- **[TEST]** SQL: foreign-org call raises 42501; own-org call succeeds; anon has no EXECUTE; `search_path` pinned; `SECURITY DEFINER` retained.
- **[TEST]** Vitest: guard matrix includes the cash/bank RPCs so a future report cannot bypass the gate.

### Phase 2 — Cash Flow correctness (server-owned)
Move the statement into a `finance_cash_flow_statement` SECURITY DEFINER RPC + service + hook, matching the sales/purchase analysis pattern; derive closing cash independently from cash accounts and expose an explicit reconciliation residual; remove the `opening_balance` double-count; add the FX-effect line; replace `Math.abs` depreciation; make classification fully DB-driven with an explicit unclassified bucket surfaced to the user.

### Phase 3 — Bank Reconciliation Statement
New per-account, as-of-date reconciliation statement RPC built strictly on the existing engine (`_bank_account_movement`, `_bank_reconciliation_gl_tieout`, `bank_account_positions`): statement balance → outstanding deposits → outstanding payments → adjusted bank balance vs book balance → adjustments → adjusted book balance → residual, with drill-down to statement lines and journal entries, and per-account currency (never mixed-currency sums).

### Phase 4 — Session register cleanup
Rename the existing page to "Bank Reconciliation Sessions", move it to `cash_bank`, relabel `reconciled_balance` as "Cleared movement", drop the cross-currency KPI sum, surface `gl_tieout.divergence` and `cleared_without_posting`.

## 6. Completion status
- Phase 1: not started (proposed now)
- Phases 2-4: blocked on Phase 1 approval; scope may change based on Phase 1 findings on sibling RPCs
