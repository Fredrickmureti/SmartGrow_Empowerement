# Receivables & Partners Reporting — remediation status

## Phase 1 — Authorization hardening (COMPLETE, verified)
`finance_ar_open_items_as_of`, `finance_ar_customer_credit_as_of`,
`get_ar_summary`, `get_ap_aging_summary`, `get_control_account_reconciliation`
are SECURITY DEFINER, pin `search_path`, gate on `finance_can_read_org`, and
have `anon` EXECUTE revoked.
Guards: `supabase/tests/receivables_reporting_authorization_test.sql`.

## Phase 2 — Point-in-time receivables parity (COMPLETE, verified)
Aging and statements age against an explicit `as_of`, never the browser clock.
`src/services/finance/openItems.ts` reads `fetchArOpenItemsAsOf` /
`fetchArCustomerCreditAsOf`.
Guards: `supabase/tests/ar_aging_as_of_test.sql`,
`src/test/architecture/ar-aging-point-in-time.test.ts` (29 tests green).

## Phase 3 — Partner Ledger (COMPLETE)

### 3.1 Server-owned engine — done
`finance_partner_ledger(_org_id, _business_id, _branch_id, _side, _from, _to,
_contact_id, _search, _limit, _offset)` returns, per partner, the opening
balance, every movement with a SQL window running balance, period debit/credit
totals and the closing balance, plus grand totals and a paging envelope.
Source: `customer_ledger_entries` / `vendor_ledger_entries` (posted
`journal_entry_lines` on the AR/AP control accounts). Org-gated, `anon` revoked.

### 3.2 GL tie-out — done
`finance_partner_ledger_reconciliation(...)` returns
`ledger_total / control_account_balance / variance / in_balance`, same shape as
`finance_ar_ap_aging_reconciliation`. The page shows a variance banner when the
ledger disagrees with the control account.

### 3.3 Client seam — done
- `src/services/finance/partnerLedger.ts` — only caller of the two RPCs.
- `src/hooks/usePartnerLedger.ts` — `usePartnerLedger`,
  `usePartnerLedgerReconciliation`.
- `src/pages/reports/PartnerLedger.tsx` — the `while (true)` paging loop, the
  contact-name backfill query and all JS balance accumulation are gone; the page
  renders server numbers only.

### Defects closed in Phase 3
1. **Unbounded client paging.** Two full-history scans of the ledger per render
   (1000-row pages, no ceiling) would time out on real volumes.
2. **Branch filter leakage.** The page used
   `branch_id.eq.X, branch_id.is.null`, pulling unbranched entries into a
   branch-scoped report. The SQL engine scopes strictly
   (`_branch_id IS NULL OR branch_id = _branch_id`), matching the aging engines.
3. **No reconciliation.** There was no way to prove the ledger's closing
   position matched the AR/AP control account. Now there is.

### Finding corrected
An earlier note claimed the Partner Ledger mixed document currencies. It does
not. `journal_entry_lines.debit/credit` are BASE-currency amounts (document
currency lives in `original_debit/original_credit`), and
`finance_ap_aging_reconciliation` already ties those same columns to
`base_residual_amount`. Verified against live data: base net equals document net
and `original_currency` is unset on all AR control legs. No FX conversion is
applied in the engine — adding one would have introduced a real error.

## Guards
- `supabase/tests/partner_ledger_engine_test.sql` — definer/search_path, anon
  revoked, org gate, strict branch predicate, ledger-vs-control tie-out per
  business and per side.
- `src/test/architecture/partner-ledger-server-owned.test.ts` — no direct view
  reads, no paging loop, no JS balance math, no leaky branch predicate.
