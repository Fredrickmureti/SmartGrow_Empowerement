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

**Phase 5 — Drift removal and guards. IN PROGRESS (~75%).** 5.0–5.3 are done; 5.4–5.6 remain.

**Known verification gap:** this sandbox has no `psql`/`PGHOST`, so
`supabase/tests/ap_aging_as_of_test.sql` was written against verified live function definitions
and enum values but has **not been executed**. The next agent must run it first (see §5).

---

## 3. Pending work (in execution order)

### 5.4 Retire `finance_ap_open_items` (next task)
No app caller remains after 5.1. Remaining references are the legacy-view assertions in
`src/test/architecture/reports-data-source-contract.test.ts` and
`supabase/tests/open_items_settlement_channels_test.sql`. Either drop the view in a migration or
redefine it as a thin wrapper over `finance_ap_open_items_as_of(CURRENT_DATE)` with a comment
explaining why; update those two guards in the same change. Confirm the AR twin is untouched.

### 5.5 Server-side pagination for the vendor list
`get_ap_aging_summary` returns the whole payload and `AgedPayables.tsx` pages it in the browser
(`visibleCount`). Add `_limit`/`_offset` (or keyset on exposure) plus a server-side total and
vendor count, and switch the page to it.

### 5.6 Export parity
Prove the Aged Payables export projects the same server dataset as the screen (no second query,
no browser recomputation) and extend `ap-aging-point-in-time.test.ts` to assert it.

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
   - Confirm `finance_can_read_org` exists and that the four AP functions are `SECURITY DEFINER`,
     pin `search_path`, call the guard, and are not executable by `anon`.
   - Confirm no `finance_ap_open_items` read remains in `src/` or `supabase/functions/`.
   - Run `bunx vitest run src/test/architecture/ap-aging-point-in-time.test.ts
     src/test/architecture/ap-aging-scenario-fixtures.test.ts
     src/test/architecture/customer-statement-dataset-parity.test.ts` and
     `bunx tsgo --noEmit -p tsconfig.app.json`.
   Record the verdict (per item: confirmed / defect found) at the top of this file before editing
   code. Note: a full-suite `vitest run` currently has ~200 pre-existing failures unrelated to
   payables (WMS topics, etc.) — do not treat those as this workstream's regressions.
2. **Then resume at 5.4** and work 5.4 → 5.6 in order.
3. **Do not** start a new domain, leave a phase half-built, or add UI without its server contract.
4. Update this file at the end of your turn so it stays the authoritative status source.

---

## 6. Out of scope (unchanged)

No new tables. No new vendor identity model — supplier identity stays on `contacts` + supplier
role. All aggregation stays server-side, `SECURITY DEFINER`, matching the finance RPC convention.
