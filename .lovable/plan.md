# Cash & Banking Reporting — Handover Verification and Continuation Plan

Labels: **[FACT]** verified this session in code/DB · **[RESEARCH]** external practice · **[INFER]** reasoned · **[REC]** recommendation · **[TASK]** work · **[TEST]** test requirement

## 1. Verification of the previous engineer's claims

| Claim | Verdict | Evidence |
|---|---|---|
| Phase 1 — caller-org gate added to the GL reporting RPCs | **CONFIRMED** | `finance_can_read_org(_org_id)` present in the live bodies of `get_account_movements`, `get_general_ledger`, `get_account_balances`, `get_gl_transactions`, `get_account_balance_at_date`, `check_balance_integrity`, `get_control_account_reconciliation`; all `SECURITY DEFINER`, `search_path=public`, no `anon` EXECUTE (`pg_proc` query) |
| `finance_cash_flow_statement` RPC exists and is gated | **CONFIRMED** | live function, definer, pinned search_path, gated, `authenticated`+`service_role` only |
| Engine corrections (opening-balance equity as financing, both legs of the close excluded, FX-on-cash line, ledger-derived closing cash, `needs_classification` bucket) | **CONFIRMED in code** | migration `20260820203202`: `financing_opening_equity` bucket, `close_entries` exclusion of both legs, `fx_cash` CTE, `cash_balances` derived independently of `opening+movement`, `needs_classification` CTE |
| "Residual is now 0.00 on live data" | **UNVERIFIED** | the RPC cannot be executed from the read-only tool (`42501`); the claim is plausible but unreproduced. Re-prove it in Phase 2c with a service-role harness, not by trusting the note |
| Client seam: `src/services/finance/cashFlow.ts`, thin `useCashFlowReport`, page banners | **CONFIRMED** | service is the only RPC caller; hook contains no accounting arithmetic and keeps the consolidation gate; page renders FX line, residual and classification banners |
| "Still pending: add the RPCs to the isolation guards" | **STALE / PARTIALLY DONE** | the five GL RPCs *are* already in both `reporting-isolation-matrix.test.ts` and `reporting_isolation_matrix_test.sql`. What is genuinely missing is `finance_cash_flow_statement` itself (and `get_account_balance_at_date`) |
| Phases 3 and 4 | **NOT STARTED** | `src/pages/reports/BankReconciliationReport.tsx` is unchanged: raw PostgREST list of `bank_reconciliation_sessions`, column still labelled "Reconciled" over `reconciled_balance`, cross-currency KPI sum still present, no GL tie-out |

### New defect found during verification (not in the previous plan)

- **[FACT] Export/PDF divergence — Phase 2 is not actually complete.** The screen now reads the server engine, but the export path does not. `CashFlowReport.tsx` declares `reportType: "cash_flow"`, which `render-report` routes to `buildCashFlow` in `supabase/functions/_shared/reportDataEngine.ts`. That builder is a three-row heuristic: net income plus a working-capital lump, cash accounts identified by `name.toLowerCase().includes("cash"|"bank")`, **no investing section, no financing section, no opening/closing cash, no FX line, no reconciliation residual**. The PDF and any scheduled report therefore state a different cash flow from the screen. This violates the parent prompt's export-consistency and no-duplicate-accounting requirements.
- **[FACT]** `bank_account_positions` is *not* `SECURITY DEFINER` (it relies on RLS) — acceptable, but it means Phase 3 must either stay invoker-rights or apply the same `finance_can_read_org` gate if it becomes definer.

## 2. Corrected completion status

- Phase 1 (security): **complete**, minus two guard entries.
- Phase 2 (Cash Flow, server-owned): **engine + client seam complete; export path and tests outstanding** → not complete.
- Phase 3 (Bank Reconciliation Statement): not started.
- Phase 4 (session register cleanup): not started.

## 3. Continuation plan

### Phase 2b — close Cash Flow (next, implement now)
- **[TASK]** Delete `buildCashFlow` from `reportDataEngine.ts` and route `render-report`'s `cash_flow` case to `finance_cash_flow_statement`, mapping the JSONB into the existing `ReportResult` column/row shape (sections, items, net change, FX, opening/closing, residual). One engine, two renderers — no accounting logic left in the edge function.
- **[TASK]** Add `finance_cash_flow_statement` and `get_account_balance_at_date` to `REPORTING_RPCS` and `_reporting_matrix`.
- **[TEST]** SQL: foreign-org call raises 42501; own-org succeeds; no `anon` EXECUTE; definer + pinned `search_path`.
- **[TEST]** Vitest architecture guard: `reportDataEngine.ts` contains no cash-flow classification (no `includes("cash")` account-name matching), and `src/pages/reports/CashFlowReport.tsx` / hook contain no section arithmetic.
- **[TEST]** Service-role harness proving `opening_cash + net_cash_flow + fx_effect − derived_closing_cash = 0` on live data — the previous engineer's unverified claim, actually proved.

### Phase 3 — Bank Reconciliation Statement (per account, as of a date)
`finance_bank_reconciliation_statement(_org_id, _bank_account_id, _as_of, _business_id, _branch_id)`, definer + `finance_can_read_org`, built strictly on `_bank_account_movement`, `_bank_reconciliation_gl_tieout` and `bank_account_positions`: statement closing balance → outstanding deposits → outstanding payments → adjusted bank balance vs book/GL balance → adjustments (charges, interest, write-offs) → adjusted book balance → residual. Single account currency only, never a cross-currency sum. Drill-down to statement lines and journal entries.

### Phase 4 — Session register cleanup
Rename the existing page to "Bank Reconciliation Sessions", move it from `audit` to `cash_bank`, relabel `reconciled_balance` as "Cleared movement", remove the cross-currency KPI sum, surface `gl_tieout.divergence` and `cleared_without_posting`.

### Phase 5 (new) — Cash & Banking category coherence
Register the Phase 3 statement under `cash_bank`, keep the three artefacts distinct in kind (financial statement / reconciliation statement / register), and add a registry test asserting the category's membership so the taxonomy cannot silently drift.

## 4. Unresolved policy (documented, not blocking)
Whether cash equivalents are `cash_flow_category='cash'` only, or must also include POS / credit-card / undeposited-funds clearing detail types. Default stands: `'cash'` only, clearing accounts treated as operating working capital.
