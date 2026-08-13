# Aged Payables (AP Aging) — Authoritative Project Status

Last updated: 2026-08-13. Active workstream: **Aged Payables / AP aging domain reconstruction**
(roadmap: `.lovable/plan/aged-payables-ap-aging-domain-reconstruction-2026-08-13.md`).
Predecessor workstream (Vendor Statements) is closed and its output is a dependency of this one.

---

## 1. Fully implemented and verified

| Phase | Deliverable | Evidence |
|---|---|---|
| 1 | `finance_ap_open_items_as_of(_org,_business,_branch,_as_of)` — point-in-time AP projection off `ap_subledger_entries`; obligations and settlements both bounded by the as-of date; openness decided by residual, never `bills.status`/`amount_paid`; document **and** base currency using the FX rate at the as-of date | `supabase/migrations/20260813033038_*.sql` |
| 1 | `finance_ap_vendor_credit_as_of` — branch-scoped, date-bounded unapplied vendor credit | same migration |
| 2 | `get_ap_aging_summary` rewritten on the Phase 1 engine (per-vendor buckets + per-bill drill-down, credit as its own explicit line) | same migration |
| 2 | `get_ap_summary` (AP KPI cards) repointed at the same engine; its private aging arithmetic deleted | same migration |
| 2 | AP branch of `get_ar_ap_aging_from_ledger` repointed at the same engine | `supabase/migrations/20260813033451_*.sql` |
| 3 | `finance_ap_aging_reconciliation` — aging total vs AP control balance as of the same date, with variance | `20260813033038_*.sql` |
| 4 | `src/hooks/useApAging.ts` — typed hook, aging + reconciliation fetched in parallel | file exists, typed, no `any` payload arithmetic |
| 4 | `src/pages/purchases/AgedPayables.tsx` rebuilt — `@ts-nocheck` removed, summary band (total, not due, 0–30, 31–60, 61–90, 90+, unapplied credit, GL variance), vendor table, per-bill drill-down | 445 lines, typed |
| 5 (part) | Architecture guard `src/test/architecture/ap-aging-point-in-time.test.ts` — forbids client-side bucket/residual arithmetic, forbids reading `bills.status`/`amount_paid` for payables, requires GL reconciliation to be surfaced | test passes alongside `aging-single-source`, `ap-kpis-canonical`, `ap-credit-position-provenance` |

Bucket boundaries remain single-sourced: `finance_aging_bucket` in SQL, mirrored once in `src/services/finance/aging.ts`.

---

## 2. Currently active phase

**Phase 5 — Drift removal and guards. IN PROGRESS (~40%).**
The guard tests landed; the data-level proof and the legacy cleanup did not.

---

## 3. Pending work (in execution order)

### 5a. Scenario fixtures A–J (highest priority, blocks sign-off)
No SQL test file exists for AP aging (`supabase/tests/` has none). Add
`supabase/tests/ap_aging_as_of_test.sql` covering: not due · overdue · partial payment ·
multi-payment · one payment spanning several bills · vendor credit · payment reversal ·
historical as-of (report re-run tomorrow for yesterday returns the identical number) ·
multi-currency · branch scope. Must seed its own isolated org/business — **do not fabricate
financial rows in the live schema** (the previous agent correctly refused to).

### 5b. Cross-surface equality proof
Assert in the same fixture that, for one vendor/branch/date, the following agree:
Aged Payables total · AP KPI total (`get_ap_summary`) · Reports aging total
(`get_ar_ap_aging_from_ledger`) · Vendor Statement closing balance.

### 5c. Retire `finance_ap_open_items`
Confirm no remaining caller (check `src/services/finance/openItems.ts`, `src/hooks/useAgingReport.ts`,
`src/pages/Bills.tsx`, edge functions), then drop the "current position" view, or keep it only as a
thin wrapper over the as-of function pinned to `CURRENT_DATE` with a comment explaining why.

### 5d. Server-side pagination for the vendor list
Known, documented gap: `get_ap_aging_summary` returns the whole payload and the page pages it in
the browser. Add `_limit`/`_offset` (or keyset on exposure) plus a server total, and switch the
page to it. Until then large books load slowly.

### 5e. Export parity
Verify the Aged Payables export projects the same server dataset as the screen (no second query,
no browser recomputation) — extend the guard test to assert it.

---

## 4. Next milestone after Phase 5 closes

Nothing new is opened until 5a–5e are green. The next logical milestone in the AP roadmap is the
**AP aging ↔ Vendor Statement ↔ GL trial-balance reconciliation surface**: expose
`finance_ap_aging_reconciliation` variance drill-down (which documents cause the variance) as a
first-class operator screen rather than a header badge. Only after that should an unrelated domain
be picked up.

---

## 5. Instructions for the next agent

1. **Verify before you build.** Do not trust this document. Independently confirm, against the live
   database and the code:
   - `finance_ap_open_items_as_of` and `finance_ap_vendor_credit_as_of` exist, are
     `SECURITY DEFINER` with a pinned `search_path`, have org-membership checks, and are granted to
     `authenticated` and `service_role`;
   - `get_ap_aging_summary`, `get_ap_summary` and the AP branch of `get_ar_ap_aging_from_ledger`
     each have exactly one overload and contain **no** private aging arithmetic;
   - `src/pages/purchases/AgedPayables.tsx` carries no `@ts-nocheck` and performs no bucket,
     residual or total arithmetic in the browser;
   - `bun run test src/test/architecture` and the TypeScript check are green.
   Record the verdict (per item: confirmed / defect found) at the top of this file before editing code.
2. **Then resume at Phase 5a** — scenario fixtures — and work 5a → 5e in order.
3. **Do not** start a new domain, leave a phase half-built, or add UI without its server contract.
   Each phase reaches a coherent, production-ready state before the next begins.
4. Update this file at the end of your turn so it stays the authoritative status source.

---

## 6. Out of scope (unchanged)

No new tables. No new vendor identity model — supplier identity stays on `contacts` + supplier role.
All aggregation stays server-side, `SECURITY DEFINER`, matching the existing finance RPC convention.
