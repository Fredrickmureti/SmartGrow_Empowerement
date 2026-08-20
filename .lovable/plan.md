# Receivables & Partners Reporting — status and roadmap

Authoritative status document. Update at the end of every phase.
Record what was **verified**, not what was written.

---

## Completed and verified

### Phase 1 — Authorization hardening — ✅ DONE (verified earlier sessions)
`get_control_account_reconciliation`, `get_ar_summary`, `get_ap_summary`,
`get_ar_ap_aging_from_ledger`: single definition, `SECURITY DEFINER`, pinned
`search_path`, `finance_can_read_org` gate, no `anon` EXECUTE.
Guard: `supabase/tests/receivables_reporting_authorization_test.sql`.

### Phase 2 — Receivables point-in-time parity — ✅ DONE (verified)
`finance_ar_open_items_as_of`, `finance_ar_customer_credit_as_of`,
`finance_ar_aging_reconciliation` + `src/services/finance/openItems.ts`.

### Phase 3 — Partner Ledger in SQL — ✅ DONE (verified)
`finance_partner_ledger`, `finance_partner_ledger_reconciliation`,
`src/services/finance/partnerLedger.ts`, `src/hooks/usePartnerLedger.ts`,
`supabase/tests/partner_ledger_engine_test.sql`,
`src/test/architecture/partner-ledger-server-owned.test.ts` (10 tests green).

### Phase 4 — Sales Reports as a real accounting report — ✅ COMPLETE (this session)

| Item | State | Evidence |
| --- | --- | --- |
| 4.1 Taxonomy verdict (one report, six dimensions) | done | encoded as `_dimension` on one engine |
| 4.2 `finance_sales_analysis` | verified in live catalog | definer, `search_path=public`, `finance_can_read_org`, no anon EXECUTE |
| 4.3 `finance_sales_revenue_reconciliation` | verified in live catalog | same hardening; posted JEs only; reports `variance` / `in_balance` |
| 4.4 Client seam | done | `src/services/finance/salesAnalysis.ts` (only RPC caller) + `src/hooks/useSalesAnalysis.ts` |
| 4.5 Page rebuild | done | `src/pages/reports/SalesReports.tsx`: no `useInvoices`, no `reduce`, engine totals footer, URL-owned dimension (`group` scope key), GL variance banner, export over the same unpaged dataset, customer drill-down via `DrillDownDialog` |
| 4.6 Guards | done | `supabase/tests/sales_analysis_engine_test.sql`, `src/test/architecture/sales-analysis-server-owned.test.ts` (8 tests green) |
| 4.7 Verification | partial — see below | typecheck clean, build OK, architecture suites green |

**Verified facts (queried against the live catalog, not assumed):** both sales
functions are `SECURITY DEFINER` with `search_path=public`, call
`finance_can_read_org`, are **not** executable by `anon`; the analysis body
excludes unposted (`journal_entry_id IS NOT NULL`) and voided documents,
normalises through `exchange_rate`, subtracts `credit_note_items`, and scopes
business/branch strictly (no `OR branch_id IS NULL` leak); the reconciliation
body uses the `sales_revenue` / `sales_returns` / `discount_given` account roles
over posted journal entries and reports a variance.

**Design decisions recorded:** drill-down is offered only on the *customer*
dimension, where a document-ownership relationship actually exists (partner
invoices via `DrillDownDialog`); product / category / branch / salesperson /
month are groupings and deliberately have no fabricated drill path. The export
does not re-run the RPC because the page queries the engine unpaged — the
exported rows are the same dataset and the same column declaration.

**Open verification item (not a defect, an access limitation).** A live
numeric smoke test of both RPCs could not be run: the read-only query role is
correctly denied EXECUTE, and this project's Supabase is external/unmanaged so
no authenticated browser session can be injected. **Next agent: sign in to the
preview and open `/finance/reports/sales`,** confirm for a closed month that
(a) rows render per dimension, (b) the totals footer equals the engine
envelope, (c) the reconciliation banner shows `in_balance = true` or a variance
that is investigated as a bookkeeping finding — never tuned away.

---

### Phase 5 — Report taxonomy & security closure — ✅ COMPLETE (this session)

| Item | State | Evidence |
| --- | --- | --- |
| 5.1 Direct-RPC isolation matrix | done | `supabase/tests/reporting_isolation_matrix_test.sql` — all 11 domain RPCs: single definition, definer, pinned `search_path`, `finance_can_read_org`, no `anon` EXECUTE, `_org_id` first argument, no `OR branch_id IS NULL` widening, `42501` on a foreign org, RLS on `invoices`/`bills` |
| 5.2 Drill-down isolation | done | `DrillDownDialog` verified org-scoped on both paths (GL via `_org_id`, partner via `.eq("organization_id", …)` + business filter), document kind whitelisted to invoice/bill; guarded by `src/test/architecture/reporting-isolation-matrix.test.ts` |
| 5.3 Registry coverage | done | all four families in `REPORT_REGISTRY` with resolvable domain, related reports and declared `drillDown`; guarded by the same suite (11 tests green) alongside the existing `reports-routing-parity` guard |
| 5.4 Security-linter pass | done | linter run; the family's definer-executable-by-authenticated findings are **accepted by design** (caller-supplied `_org_id` + `finance_can_read_org` gate) and recorded in security memory, not left open |

**Verified facts (live catalog, queried not assumed):** all 11 RPCs listed in
the matrix are `SECURITY DEFINER`, `search_path=public`, call
`finance_can_read_org`, take `_org_id uuid` first, and are **not** executable
by `anon`. Linter reports no `anon`-executable definer function in this family.

**Carried over — still open (access limitation, not a defect).** The live
numeric smoke test of the sales RPCs from a signed-in session (Phase 4.7) has
not been performed: the read-only query role is correctly denied EXECUTE and
this project's Supabase is external/unmanaged, so no browser session can be
injected. **Next agent: sign in to the preview, open
`/finance/reports/sales`,** and for a closed month confirm (a) rows render per
dimension, (b) the totals footer equals the engine envelope, (c) the
reconciliation banner shows `in_balance = true` or a variance that is
investigated as a bookkeeping finding — never tuned away.

---

## ▶ NEXT — Phase 6 — Purchases & payables reporting parity (not started)

The receivables side is now fully server-owned; the purchases side is not yet
held to the same contract. Phase 6 applies the identical pattern:

1. **Audit the Purchases reports** the way Sales was audited: does the page do
   browser-side arithmetic over bills / debit notes, and is there a single
   report or several overlapping ones?
2. **`finance_purchase_analysis`** — one engine, dimensions
   supplier / product / category / branch / month, posted non-void documents
   only, base currency, purchase returns subtracted, hardened exactly like
   `finance_sales_analysis`.
3. **`finance_purchase_expense_reconciliation`** — document purchases vs the
   GL accounts carrying the `purchases` / `purchase_returns` roles.
4. **Client seam + page rebuild + export + supplier drill-down**, mirroring
   `salesAnalysis.ts` / `useSalesAnalysis.ts` / `SalesReports.tsx`.
5. **Guards**: SQL contract suite + architecture suite, and extend
   `reporting_isolation_matrix_test.sql` and
   `reporting-isolation-matrix.test.ts` with the two new functions.

## Notes
- No second reporting engine: `ReportSurface` / `ReportTable` /
  `toExportColumns` / `toExportRows` remain the only presentation layer.
- No accounting arithmetic in React. All measures come from SQL in base
  currency.
- Ledger `debit`/`credit` are already base currency — never add FX conversion
  on top of them (document currency lives in `original_debit`/`original_credit`).
- The isolation matrix is the domain's registry of reporting RPCs: any new
  report function in this family must be added to **both** matrix files in the
  same change that creates it.

## Instructions for the next agent
1. **Verify before continuing.** Re-check Phases 4 and 5 against the codebase
   and the live catalog (not this file): `SalesReports.tsx` holds no invoice
   arithmetic, the services are the only RPC callers, and all four SQL suites
   plus the architecture suites pass. Confirm the 11 matrix functions still
   carry definer + pinned `search_path` + org gate + no `anon` EXECUTE.
2. **Clear the carried-over item** by running the signed-in sales smoke test
   described above, then delete it from this file.
3. **Then start Phase 6, item 1.** Do not open unrelated report families or
   leave a phase half-shipped: each phase lands SQL + client seam + page +
   export + tests together.

