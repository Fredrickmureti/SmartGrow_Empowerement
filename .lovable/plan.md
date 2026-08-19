# Account Register vs Account-level GL Report — Investigation Findings

Scope: Chart of Accounts account view, Account Register, General Ledger report, Trial Balance. No code changed.

## Phase 1 — Accounting model (A = principle, B = common enterprise practice)

- **Account register** (A/B): chronological transaction list for ONE account, brought-forward opening balance, per-line debit/credit, running balance after each line, closing balance. Purpose: reconciliation and drill-down. Register is a *detail* view; it must always show opening/closing even with zero period activity (a brought-forward balance is information).
- **Account-level GL report** (A/B): same detail semantics but as a formal report artifact — per-account section with opening balance line, lines, "total movement" (period DR total, CR total), closing balance; usable across many accounts; printable/archivable. Odoo (General Ledger), NetSuite (GL Detail), Dynamics (Detail Trial Balance) all follow this shape.
- **Trial balance** (A/B): one row per account, no transaction detail; mature systems present 6 columns Opening DR/CR, Movement DR/CR, Closing DR/CR. Purpose: proof that DR totals = CR totals and period-level summarization.
- **CoA account view** (B): master-data list + current balance; not a report.
- **Sign convention** (A): balances presented in the account's *natural* direction (assets/expenses debit-positive; liabilities/equity/income credit-positive), or as explicit DR/CR columns. A single view must not mix debit-signed and natural-signed numbers.
- Zero-activity + zero-balance accounts: excluded unless "include zero" is chosen. Opening-balance-only accounts: shown, with opening = closing. Accounts netting to zero closing: shown (activity exists).
- Branch/business/currency: register and GL must honour the same dimension filters as the trial balance, otherwise the detail cannot be tied back to the summary.

## Phase 2-5 — Actual implementation (C)

- CoA: `src/pages/Accounts.tsx` → `effectiveBalance = rpcBalance(id) + accounts.opening_balance`, where `get_account_balances` returns `SUM(debit) - SUM(credit)` (debit-signed, all-time, branch filtered on `journal_entry_lines.branch_id`). Row actions link to `/finance/accounts/register?account_id=` and `/finance/reports/general-ledger?account_id=`.
- Register: `src/pages/finance/AccountRegister.tsx`, data from `useGeneralLedger` (single account, no branch param), recomputes its own running balance client-side (lines 134-145).
- GL report: `src/pages/reports/GeneralLedger.tsx`, same hook, renders via `@/design-system/reports` (section / opening row / lines / "Total Movement" subtotal / grand total); passes `filters.branchId`.
- Hook `src/hooks/useGeneralLedger.ts` → RPC `get_general_ledger` (verified via `pg_get_functiondef`). RPC returns `opening_balance = accounts.opening_balance + SUM(debit - credit) for entry_date < from` — **debit-signed** — then the client adds period movement in the account's **natural** direction.
- Trial balance: `useFinancialReport` + `accountingKernel.calculateBalance` — natural-signed throughout.
- PDF/server engine: `supabase/functions/_shared/reportDataEngine.ts` lines 253-261 computes opening naturally (`prior.credit - prior.debit` for credit-normal) and runs the register the same way (lines 580-608).
- Multi-tenant: `get_general_ledger` validates business∈org and branch∈org/business, filters `je.organization_id`, `je.status='posted'`, business, branch; accounts scoped by `organization_id` + `business_id`. Hook has a consolidation gate when no company is selected and org has >1.

## Verdicts

### 1. CONFIRMED DEFECT — mixed sign convention in `get_general_ledger.opening_balance`
- Location: DB function `public.get_general_ledger` (opening expression `s.opening_balance + COALESCE(p.prior_net,0)`, `prior AS SUM(jel.debit - jel.credit)`); consumed by `useGeneralLedger` (lines 128-179) and both UI screens.
- Evidence: posted data — account 3900 (equity) credit 50,000 on 2026-08-01 and 50,400 on 2026-08-18. For period from 2026-08-10 the RPC yields opening = **-50,000**; the client then computes running = -50,000 + 50,400 = **+400**; true closing is **100,400**. Trial balance (`calculateBalance`) and the server PDF engine both yield +50,000 / +100,400 → UI vs PDF vs TB disagree.
- Expected: opening in natural direction for credit-normal accounts. Actual: debit-signed opening added to natural-signed movement.
- Why it matters: register and GL report show wrong opening, running and closing balances for every liability/equity/income account whenever the period has prior activity, and they contradict the trial balance and the archived PDF.
- Smallest safe correction: in the RPC, sign `prior_net` by account type (`CASE WHEN a.account_type IN ('asset','expense') THEN SUM(debit-credit) ELSE SUM(credit-debit) END`), i.e. reuse the kernel rule; no client change needed. Also confirm `accounts.opening_balance` is stored natural-signed before summing (verify against `migrate_opening_balances_to_je`).
- Affected: Account Register, General Ledger report, anything else calling `get_general_ledger`.
- Regression risk: debit-normal accounts must stay unchanged; drill-down dialogs and exports read the same fields.
- Tests: RPC-level test per account type with prior + in-period activity; parity test asserting register/GL closing == trial-balance closing for the same as-of date; parity vs `reportDataEngine`.

### 2. CONFIRMED DEFECT — register hides opening-balance-only accounts
- Location: `AccountRegister.tsx` line 196 `isEmpty={!isLoading && transactionsWithBalance.length === 0}`.
- Evidence: RPC returns the account row (opening ≠ 0) with `line_id` NULL; the page then renders the "No activity on this account" empty state, discarding the opening/closing cards.
- Expected: show brought-forward opening = closing with an empty line list. Fix: `isEmpty` only when there is no account row at all (no opening balance and no lines).
- Tests: register for an account with prior-period balance and no in-period lines.

### 3. CONFIRMED DEFECT — running balance recomputed over the *search-filtered* subset
- Location: `AccountRegister.tsx` lines 126-145 (running balance derived from `filteredTransactions`, ignoring `txn.running_balance` already supplied by the hook).
- Evidence: with a search term active, each row's balance is a partial cumulative sum, while the closing-balance card uses `accountData.closing_balance` (full set) — the table's last row and the card disagree.
- Expected: running balance is a ledger property, not a view property. Fix: render `txn.running_balance` from the hook and keep search as pure row filtering (optionally label the view as filtered).
- Regression risk: none beyond removing duplicated math (the hook already computes it identically).

### 4. CONFIRMED DEFECT — register crashes / mis-queries with no company in context
- Location: `AccountRegister.tsx` line 106 `q.eq("business_id", currentBusiness!.id)` (non-null assertion) and the missing consolidation surface.
- Evidence: `useGeneralLedger` treats `currentBusiness?.id` as optional and returns `requiresConsolidation` when no company is selected in a multi-company org; the register neither guards the assertion nor surfaces `requiresConsolidation`, so it shows "No activity on this account".
- Fix: guard the opening-balance JE lookup on `currentBusiness?.id`, and render the consolidation message when `data.requiresConsolidation`.

### 5. ACCOUNTING SEMANTICS ISSUE — register ignores the branch dimension
- Evidence: GL report passes `filters.branchId`; TB passes `filters.branchId`; register calls `useGeneralLedger` with no `branchId` (line 115-120) so it is always company-wide.
- Why it matters: a branch-scoped trial balance cannot be tied to the register. Correction: give the register the same `ReportBranchFilter` and pass `branchId` through (the RPC already supports and validates it).

### 6. EXPECTED BEHAVIOR — no new Reference column
- `entry_number` identifies the journal entry (drill-down target); `je.reference` is the source-document reference already surfaced inline (register lines 378-390, GL line 137 `(Ref: …)`), and drill-down to the JE/source is available from Entry #. Adding a Reference column would diverge from the registry-wide 6-column register shape without adding navigational capability. Do not change.

### 7. EXPECTED BEHAVIOR — register vs GL report presentation difference
- Register = single-account operational workspace (KPI cards, account stepper, search, plain table). GL report = multi-account report artifact via `ReportSurface`/`ReportTable` with section/subtotal/grand-total rows and PDF parity. Both read one RPC; divergence is report intent, not drift. Do not unify visuals.

### 8. EXPECTED BEHAVIOR — multi-tenant isolation on this path
- `get_general_ledger` is SECURITY DEFINER but validates business∈org and branch∈org/business, and filters org + business + branch + `status='posted'`; accounts are org+business scoped; zero rows show `journal_entries.branch_id` disagreeing with line-level `branch_id` in current data (0 mismatched entries).

### 9. INSUFFICIENT EVIDENCE — branch filtering level inconsistency across RPCs
- `get_general_ledger` filters `je.branch_id`; `get_account_balances` filters `journal_entry_lines.branch_id`. Both columns are populated (18/18 lines, 8/8 entries) and currently never disagree, so no defect is demonstrable. Missing evidence: whether any writer is allowed to post lines to a branch other than the entry header's. Decide the authoritative branch level (header vs line) before touching either RPC.

### 10. INSUFFICIENT EVIDENCE — `accounts.opening_balance` double-count risk
- Both `get_general_ledger` and `reportDataEngine` add `accounts.opening_balance` on top of prior JE movement, while `migrate_opening_balances_to_je` creates migration JEs for opening balances. Missing evidence: whether that RPC zeroes `accounts.opening_balance` after migrating. Verify before fix #1 lands, since #1 sums the same field.

## Execution order (when approved)
1. Verify `accounts.opening_balance` sign + post-migration zeroing (finding 10).
2. Migration fixing `get_general_ledger.opening_balance` sign (finding 1) + RPC/parity tests.
3. Register fixes: empty state (2), running balance source (3), company-context guard (4), branch filter (5).
4. No changes for findings 6-9.
