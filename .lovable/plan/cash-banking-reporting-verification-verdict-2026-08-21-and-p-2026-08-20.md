# Cash & Banking Reporting — Verification Verdict (2026-08-21) and Phase 11

Legend: **[FACT]** re-verified this session against code/DB · **[FINDING]** defect ·
**[TASK]** work · **[TEST]** test requirement · **[OPEN]** unresolved policy

## Phase 1 — Independent verification of the previous engineer's claims

| Claim | Verdict |
| --- | --- |
| Phase 10 engine returns ranked `residual_explanations` | **[FACT] TRUE.** `finance_bank_reconciliation_statement` source contains `residual_explanations` and the `duplicate_opening_balance` code. |
| Client seam + `ResidualExplainer` render it, presentation only | **[FACT] TRUE.** `src/components/reports/ResidualExplainer.tsx` does no arithmetic, no data access; renders title/detail/amount/refs. |
| Phase 8 unreconcile is wired | **[FACT] TRUE.** `useBankTransactions.unreconcileTransaction` calls `unreconcile_bank_transaction`; no client writes to reconciliation state. |
| Export coherence tasks 5a–5d ("pending" in the older handover) | **[FACT] ACTUALLY DONE.** `render-report` switch now has a `bank_reconciliation` case, `_shared/reportDataEngine.ts` exposes `buildBankReconciliation` calling the same RPC, and `CashFlowReport.getExportConfig` returns a `ServerBuildConfig`. Older notes are stale here. |
| Live −50,000.00 KES residual is a duplicated opening balance | **[FACT] TRUE, confirmed in data.** Bank account "Test Operating Bank – KES" has `opening_balance_je_id = ecb783f4…` (JE-00007, `source_type='opening_balance'`, 2026-08-01) **and** statement line 2026-07-31 "Opening balance" +50,000.00 reconciled to JE-00009 (`source_type='bank_reconciliation'`). Both posted. Same 50,000 counted twice. |
| Phase 11 (remedies / un-match ADR) started | **[FACT] FALSE.** No remedy map anywhere near the explainer; no ADR on un-matching a posted line in `docs/adr/` or `docs/architecture/decisions/`. Correctly marked pending. |

### New findings this session

1. **[FINDING] The claimed `unreconcile_bank_transaction` P0001 is NOT explained by the current
   server code.** Reading the function: it reverses settlements through `void_payment_atomic` /
   `void_bill_payment_atomic`, and otherwise voids `bank_transactions.journal_entry_id` through
   `void_journal_entry_atomic`, which legally moves a posted entry to `reversed`. The
   `Cannot modify a posted journal entry…` text lives only in
   `enforce_journal_entry_immutability`, whose final branch fires when a **posted** entry is
   updated in place with status unchanged. No trigger on `bank_transactions` performs such an
   update. So either the error came from a different action than believed, or from a path not yet
   identified. **The previous engineer's root cause is unverified — reproduce before designing.**
2. **[FINDING] Un-match legality is invisible to the UI.** `unreconcile_bank_transaction` can
   refuse for at least four distinct reasons (`BANK_UNRECONCILE_PERIOD_LOCKED`,
   `BANK_UNRECONCILE_MISSING_SETTLEMENT`, `assert_can_reconcile_bank` permission failure, void
   refusals such as "Cannot void a reversal journal entry"). Nothing pre-flights these; the button
   is always enabled and failures surface as raw Postgres text.
3. **[FINDING] Diagnoses are dead ends.** Every `residual_explanation` code names rows but offers
   no action, no deep link, no drill-down — the accountant must find the entry manually.
4. **[FINDING] The duplicated opening balance is a class, not an incident.** Nothing prevents a
   statement line from being classified to the same bank control account that already carries the
   `opening_balance_je_id` posting. Worth a guard, not only a data fix.

## Accounting position (unchanged, restated)

Reconciliation state is a consequence of a posting (ADR-0144). Un-matching therefore has two
separable acts: **breaking the link** (operational) and **reversing the posting** (accounting).
Today they are fused inside one RPC. Whether they should stay fused is exactly what Phase 11.0
research must settle — enterprise practice, not our convenience.

## Phase 11 — Actionable reconciliation workspace (the active phase)

### 11.0 Research → ADR (in flight)
**[TASK]** Research Dynamics 365 BC/F&O, Oracle Fusion Cash Management, NetSuite, SAP S/4HANA
(FEBAN / FBRA), QuickBooks, Xero on: does un-match (a) refuse and force a reversing entry,
(b) break the match leaving the GL untouched, or (c) auto-generate the reversal — and what changes
when the period is closed. Land as `docs/adr/0149-un-matching-a-posted-bank-line.md` with sources
and an explicit verdict for this ERP.

### 11.1 Reproduce before repairing
**[TASK]** Drive the live "Joshua Holdings" / Test Operating Bank KES account in the browser and
attempt "Unreconcile" on the duplicated opening-balance line; capture the exact RPC response.
Only then decide whether a server change is needed. If the RPC in fact succeeds, finding 1 above
retires and Phase 11 shrinks to remedies + pre-flight.

### 11.2 Pre-flight legality (no dead-end buttons)
**[TASK]** One server-side read (`bank_unmatch_preflight(_bank_transaction_id)`) returning
`{ allowed, code, reason, requires }` reusing the same predicates the writer enforces — never a
second copy of the rules. UI disables the action with the stated reason.

### 11.3 Every diagnosis carries a declared remedy
**[TASK]** One declarative remedy table (data, not `if/else`) mapping explanation code → label,
permission, precondition, deep link or in-place action:
`duplicate_opening_balance` → guarded void-with-preview of the duplicate entry;
`unmatched_equal_pairs` → match sheet with both sides preselected;
`sign_flipped_pairs` → open the line; `cleared_without_posting` → post via the owning document;
`single_item_equals_residual` → open in the match sheet; `fx_fallback_lines` → FX rates for the
affected dates. Deep links carry account, session, date range and entry id.

### 11.4 Errors become guidance
**[TASK]** Map every known reconciliation error code to an explanation plus the next legal action;
unknown codes get a generic message plus a support reference. No raw Postgres text in a toast.

### 11.5 Guard the class, not the incident
**[TASK]** Prevent (or at minimum warn at classification time) a statement line being posted to a
bank control account whose opening balance is already posted for a date on/before the account's
opening date. Data fix for Joshua Holdings executed through `void_journal_entry_atomic`, never a
direct UPDATE.

### 11.6 Proof
- **[TEST]** SQL invariants: un-match legality matrix (posted / unposted / period-locked /
  missing settlement / no permission); idempotent re-run; no path mutates a posted entry outside
  `void_journal_entry_atomic`.
- **[TEST]** Architecture guard: every explanation code has exactly one remedy entry; explainer
  still performs no arithmetic and no direct `supabase` access.
- **[TEST]** Browser: the finding appears, its action is offered, completes or is refused with a
  human reason, and the residual reflects the outcome.

## Then — Phase 12 (rule engine scrutiny), Phase 13 (feed→GL chain proof), Phase 14 (branch dimension, needs migration)

Unchanged from the prior roadmap; not to be started before Phase 11 closes.

## [OPEN] policy
Whether cash equivalents are `cash_flow_category='cash'` only, or must also include POS /
credit-card / undeposited-funds clearing accounts. Default stands: `'cash'` only.
