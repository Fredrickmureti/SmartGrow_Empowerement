# Aged Payables (AP Aging) — Authoritative Project Status

Last updated: 2026-08-13 (13:40 EAT). Active workstream: **Aged Payables / AP aging domain
reconstruction**. Predecessor workstream (Vendor Statements) is closed and is a dependency of
this one.

---

## 1. Fully implemented and verified

| Phase | Deliverable | Evidence |
|---|---|---|
| 1 | `finance_ap_open_items_as_of` — point-in-time AP projection off `ap_subledger_entries`; obligations and settlements both bounded by the as-of date; openness decided by residual, never `bills.status` / `amount_paid`; document and base currency | `supabase/migrations/20260813033038_*.sql` |
| 1 | `finance_ap_vendor_credit_as_of` — branch-scoped, date-bounded unapplied vendor credit | same migration |
| 2 | `get_ap_aging_summary`, `get_ap_summary` and the AP branch of `get_ar_ap_aging_from_ledger` all rewritten on the Phase 1 engine; no private aging arithmetic remains | `20260813033038_*.sql`, `20260813033451_*.sql` |
| 3 | `finance_ap_aging_reconciliation` — net aging vs AP control balance with variance | `20260813033038_*.sql` |
| 4 | `src/hooks/useApAging.ts` + rebuilt `src/pages/purchases/AgedPayables.tsx` (typed, no `@ts-nocheck`, zero browser arithmetic) | verified this workstream |
| 5.0 | **Authorization hardening.** `public.finance_can_read_org(_org_id)` (service_role bypass + `is_org_member`); the four AP functions converted to PL/pgSQL with the guard; EXECUTE revoked from `PUBLIC`/`anon`, granted to `authenticated`/`service_role` | migration `*_locks_down_the_payables_aging.sql` |
| 5.1 | **Single-engine consumer convergence.** `fetchApOpenItemsAsOf` / `fetchApVendorCreditAsOf` added to `src/services/finance/openItems.ts` and now back `fetchTopOpenCounterparties`, `fetchPayableCounterparties`, `fetchUnappliedVendorCredit`, `fetchContactOpenItemAging`. Browser overdue-day math deleted (engine supplies `days_past_due` / `aging_bucket`). The vendor-statement PDF path in `supabase/functions/generate-document/index.ts` now calls the RPC at `periodEnd` and uses the SQL bucket | typecheck green; `customer-statement-dataset-parity` guard updated and passing |
| 5.2 | **Scenario fixtures A–J.** `supabase/tests/ap_aging_as_of_test.sql` — isolated seeded org, rolled back: not due · 45-day overdue · partial payment · multi-payment · one payment across two bills · vendor credit (applied + unapplied) · reversed payment · historical as-of · multi-currency base conversion · branch scope. Plus contract assertions (single overload, SECURITY DEFINER + pinned `search_path` + org guard, not anon-executable, no `amount_paid` in the aging report) | `supabase/tests/ap_aging_as_of_test.sql`; guarded by `src/test/architecture/ap-aging-scenario-fixtures.test.ts` |
| 5.3 | **Cross-surface equality proof** embedded in the same fixture: engine gross − unapplied credit must equal `get_ap_summary.total_residual`, `get_ap_aging_summary.totals.total`, and `finance_ap_aging_reconciliation.aging_total` | same file |

Bucket boundaries stay single-sourced: `finance_aging_bucket` in SQL, mirrored once in
`src/services/finance/aging.ts`.

---

## 2. Currently active phase

**Phase 5 — Drift removal and guards. IN PROGRESS (~95%).** 5.0–5.5 are done; only 5.6 remains.

**Known verification gap:** this sandbox has no `psql`/`PGHOST`, so
`supabase/tests/ap_aging_as_of_test.sql` was written against verified live function definitions
and enum values but has **not been executed**. The next agent must run it first (see §5).

---

## 2b. Completed this turn — 5.5 Server-side pagination (verified)

- Migration: `get_ap_aging_summary` now takes `p_search`, `p_limit`, `p_offset`; returns
  `vendors` (the page), `page` (`limit/offset/search/returned/has_more`), `filtered`
  (`vendor_count`, `total` for the searched cohort) and unfiltered grand `totals` for the KPI
  strip. Search and ordering happen in SQL. Guard switched to `finance_can_read_org`; `PUBLIC`
  and `anon` revoked; the old 4-arg overload dropped so there is a single entry point.
- `src/hooks/useApAging.ts`: exported `fetchApAging` (one fetch path), added
  `search/limit/offset` args, `page` in the result, `placeholderData` for smooth paging.
- `src/pages/purchases/AgedPayables.tsx`: debounced server search, `Show more` raises the server
  page limit, "Showing N of M vendors", no browser `filter`/`slice`; export re-runs
  `fetchApAging({ limit: null })` — same engine, full searched cohort.
- `ReportExportButtons` / `ReportPreviewDialog` / `EmailReportDialog` now accept an async
  `getExportConfig`/`buildConfig` (needed for export-time full fetch).
- New guard `src/test/architecture/ap-aging-server-pagination.test.ts` (5 tests, passing);
  existing AP guards and `tsgo --noEmit -p tsconfig.app.json` pass.

---

## 3. Pending work (in execution order)

### 5.6 Export parity (next task)
The export already re-queries the engine with `limit: null` (5.5). What remains: extend
`ap-aging-point-in-time.test.ts` to assert export rows and screen rows come from the same RPC,
with no browser recomputation of buckets or totals, and that the grand-total row uses the
server `totals` payload.

---

## 4. Next milestone after Phase 5 closes

The **AP aging ↔ Vendor Statement ↔ GL trial-balance reconciliation surface**: promote
`finance_ap_aging_reconciliation` from a header badge to a first-class operator screen with
variance drill-down (which documents cause the variance). No unrelated domain until then.

---

## 5. Instructions for the next agent

1. **Verify before you build.** Do not trust this document.
   - Execute `supabase/tests/ap_aging_as_of_test.sql` against a database and fix any failure it
     reports. This is the highest-priority item: the fixture is written but unexecuted.
   - Verify 5.5: `get_ap_aging_summary` exists ONLY in the 7-arg form, is `SECURITY DEFINER` with
     pinned `search_path`, calls `finance_can_read_org`, is not executable by `anon`, and that a
     paged call plus an unlimited call return identical grand `totals`.
   - Confirm `finance_can_read_org` exists and that the four AP functions are `SECURITY DEFINER`,
     pin `search_path`, call the guard, and are not executable by `anon`.
   - Confirm no `finance_ap_open_items` read remains in `src/` or `supabase/functions/`.
   - Run `bunx vitest run src/test/architecture/ap-aging-point-in-time.test.ts
     src/test/architecture/ap-aging-scenario-fixtures.test.ts
     src/test/architecture/ap-aging-server-pagination.test.ts
     src/test/architecture/customer-statement-dataset-parity.test.ts` and
     `bunx tsgo --noEmit -p tsconfig.app.json`.
   Record the verdict (per item: confirmed / defect found) at the top of this file before editing
   code. Note: a full-suite `vitest run` currently has ~200 pre-existing failures unrelated to
   payables (WMS topics, etc.) — do not treat those as this workstream's regressions.
2. **Then resume at 5.6**, then close Phase 5 and move to the reconciliation surface in §4.
3. **Do not** start a new domain, leave a phase half-built, or add UI without its server contract.
4. Update this file at the end of your turn so it stays the authoritative status source.


---

## 6. Out of scope (unchanged)

No new tables. No new vendor identity model — supplier identity stays on `contacts` + supplier
role. All aggregation stays server-side, `SECURITY DEFINER`, matching the finance RPC convention.
