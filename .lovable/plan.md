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

## Phase 3 — Partner Ledger (COMPLETE in code; live tie-out re-check pending)

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

### 3.4 Export & drill-down — done (this session)
- **Export** re-uses the same `columns` / `rows` declaration the screen renders,
  and the engine is called unpaged (`limit: null`), so the export is the full
  period dataset, not a re-aggregation of a visible page.
- **Grand totals** now come from the engine's `totals` envelope
  (`total_debit`, `total_credit`, `closing_balance`). The page no longer adds
  partner subtotals together to invent a footer figure.
- **Drill-down** goes to the originating journal entry. Each movement carries
  `journal_entry_id` from the engine and the amount opens
  `TransactionPreviewDrawer` with `sourceType="journal_entry"`. The old
  `DrillDownDialog` call passed only a date range with no `accountId`, so it
  could never return rows — a dead drill-down is now a real one. Amounts with no
  journal entry render as plain text instead of a dead button.
- Guards extended in `src/test/architecture/partner-ledger-server-owned.test.ts`
  (10 tests green): no JS grand-total accumulation, drill-down targets
  `journal_entry`, service carries `journal_entry_id`.

## Verification status — what is fact, what is not
- **VERIFIED (static + tests):** typecheck clean; `partner-ledger-server-owned`
  (10) and `ar-aging-point-in-time` (5) green.
- **NOT VERIFIED against live data this session (INFERENCE):** the engine's
  numbers and the GL tie-out could not be re-exercised. The read-only query role
  is denied EXECUTE on `finance_partner_ledger` (correct hardening), and browser
  auth reports `external_unmanaged`, so no authenticated session can be minted in
  the sandbox. The earlier zero-variance check stands from the previous session;
  it must be re-run from a signed-in session before Phase 3 is called closed on
  data as well as on code.

## ▶ NEXT — Phase 4 — Sales Reports as a real accounting report (not started)
Nothing has been built. Do it in this order:
### 4.1 Taxonomy verdict — DONE (evidence below)
**Verdict: ONE sales analysis engine with a `_dimension` parameter, not five
report families.** Customer, product, category, branch, salesperson and month
are grouping keys over the *same* measure set and the *same* source rows.

Evidence gathered from the live schema:
- Every candidate key is reachable from one row set: `invoices` carries
  `contact_id`, `branch_id`, `salesperson_id`; `invoice_items` carries
  `product_id`; `products.category_id` gives category. No dimension needs a
  different document population.
- The measures are identical for all of them: `invoice_items`
  (`quantity * unit_price`, `discount_percent`, `tax_amount`, `line_total`),
  `credit_note_items` for returns, and `stock_movements`
  (`reference_type in ('invoice','credit_note')`, `unit_cost * quantity`) for
  cost. One aggregation, six `GROUP BY` keys.
- Base currency is a document property (`invoices.exchange_rate`,
  `credit_notes.exchange_rate`), the same convention
  `finance_ar_open_items.base_residual_amount` already uses — so normalisation
  is shared, not per-dimension.
- Splitting into families would duplicate the revenue tie-out five times and
  guarantee the variants drift.

2. **Engine.** A SQL function over the GL / dimensional sources that returns
   gross, discounts, credit notes and returns, net, tax, cost and margin — in
   base currency, definer, pinned `search_path`, `finance_can_read_org` gate,
   `anon` revoked.
3. **Revenue tie-out.** Net sales must reconcile to the revenue accounts in the
   GL, mirroring `finance_partner_ledger_reconciliation`.
4. **Page.** Replace the browser-side `useInvoices()` aggregation in
   `src/pages/reports/SalesReports.tsx`; drop its hand-built export payload in
   favour of `toExportColumns` / `toExportRows`.
5. **Guards.** SQL contract test + an architecture test asserting the page holds
   no invoice-total arithmetic.

Until step 2 lands, `SalesReports.tsx` is an invoice-activity dashboard, not a
revenue report, and must not be described as one in the UI.

## Phase 5 — Report taxonomy & security closure (not started)
Direct-RPC and drill-down isolation tests for all four reports across
org / business / branch, plus the cross-org membership matrix.

## Instructions for the next agent
1. **Verify before building.** Confirm Phase 3 to enterprise standard: read the
   `finance_partner_ledger` / `finance_partner_ledger_reconciliation` definitions
   (definer, pinned `search_path`, org gate, no `anon` EXECUTE), run
   `supabase/tests/partner_ledger_engine_test.sql` and the two architecture
   suites, and — from an authenticated session — re-run the reconciliation for a
   past month-end on both sides. A non-zero variance is a real finding: chase the
   cause, never tune the report to match.
2. **Do not redo Phases 1–3.** They are complete in code and guarded.
3. **Then start Phase 4 at step 1** (taxonomy verdict). Do not open Phase 5, and
   do not touch unrelated domains.
4. Record what was *verified*, not what was written, and update this file at the
   end of every phase.
