# Aged Payables (AP Aging) — Verification Verdict & Continuation Plan

Last updated: 2026-08-13 (incoming engineer). Scope: enterprise AP aging subsystem.

---

## 1. Verification verdict on the previous engineer's claims

Each item was checked directly against the live database and the codebase.

| Claim | Verdict | Evidence |
|---|---|---|
| `finance_ap_open_items_as_of` exists, SECURITY DEFINER, pinned `search_path` | Confirmed | `pg_proc`: `prosecdef=true`, `search_path=public`, single overload `(uuid,uuid,uuid,date)` |
| `finance_ap_vendor_credit_as_of` exists, same properties | Confirmed | same query |
| `finance_ap_aging_reconciliation` exists | Confirmed | same query |
| `get_ap_aging_summary`, `get_ap_summary`, `get_ar_ap_aging_from_ledger` each have exactly one overload | Confirmed | one row each in `pg_proc` |
| Functions have org-membership checks | **Defect** | only `get_ap_aging_summary` contains a membership assertion; `finance_ap_open_items_as_of`, `finance_ap_vendor_credit_as_of`, `finance_ap_aging_reconciliation`, `get_ap_summary` have none |
| Granted to `authenticated` / `service_role` | Confirmed, but **over-granted** | those same four are also executable by `anon` — a SECURITY DEFINER function that bypasses RLS, takes an org id as a parameter, and performs no membership check is readable by an unauthenticated caller |
| `AgedPayables.tsx` has no `@ts-nocheck`, no browser financial arithmetic | Confirmed | 446 lines; only `slice`/`map` for rendering, no bucket/residual/total math |
| `useApAging.ts` typed, parallel fetch | Confirmed | 192 lines |
| Guard tests pass | Confirmed | `ap-aging-point-in-time`, `aging-single-source`, `ap-kpis-canonical`, `ap-credit-position-provenance` — 20 tests green |
| Phase 5a scenario fixtures | Not started | no AP aging file in `supabase/tests/` |
| `finance_ap_open_items` retired | Not started | live callers: `src/services/finance/openItems.ts:165,538`, `supabase/functions/generate-document/index.ts:1850`, and transitively `useVendorStatements.ts` |
| Server-side pagination | Not started | page slices client-side (`PAGE_SIZE = 50`, `visibleCount`) over the full payload |
| Export parity | Confirmed in code, unguarded | export builds from `filteredVendors` (same server dataset), but no test asserts it |

### New defect found during verification (not in the previous plan)

**Vendor Statement aging is not point-in-time.** `useVendorStatements.ts` calls
`fetchContactOpenItemAging("ap", { asOf: period_end })`, which reads
`finance_ap_open_items` — a *current-position* view — and then only uses `asOf`
to choose buckets. Residuals are today's residuals. So for any vendor with a
payment after the statement period end, the Vendor Statement aging disagrees
with Aged Payables for the same vendor/date. This breaks the equality the
parent prompt requires (statement closing = aged payables open = subledger).

---

## 2. Continuation plan (dependency ordered)

### Phase 5.0 — Close the authorization hole (blocking, do first)
- Objective: no AP financial projection is reachable without proven org membership.
- Owner: database.
- Change: `REVOKE EXECUTE ... FROM anon` on `finance_ap_open_items_as_of`,
  `finance_ap_vendor_credit_as_of`, `finance_ap_aging_reconciliation`, `get_ap_summary`;
  add the same membership assertion `get_ap_aging_summary` already uses to each of them.
- Acceptance: an anon session gets a permission error; an authenticated member of
  another org gets an authorization error, not rows.

### Phase 5.1 — Point-in-time correctness for every AP consumer
- Objective: one as-of engine, no current-position fallback anywhere in AP.
- Change: `fetchContactOpenItemAging("ap", …)` re-pointed at
  `finance_ap_open_items_as_of`; Vendor Statement aging then becomes genuinely
  as-of the period end. Same for the `generate-document` edge function's AP read.
- Acceptance: statement re-run tomorrow for yesterday returns yesterday's numbers.

### Phase 5.2 — Scenario fixtures A–J (`supabase/tests/ap_aging_as_of_test.sql`)
Seeds its own isolated org/business/branch and rolls back; no rows written to real
tenant data. Covers: not due · overdue bucket boundaries · partial payment ·
multiple payments on one bill · one payment across several bills · vendor credit ·
bill reversal · payment reversal · historical as-of (payment after the report date
must not change the report) · multi-currency (document and base) · branch scope.

### Phase 5.3 — Cross-surface equality proof
In the same fixture, for one vendor/branch/date assert equality of:
Aged Payables total · `get_ap_summary` total · `get_ar_ap_aging_from_ledger` AP total ·
Vendor Statement closing balance · AP control-account balance
(`finance_ap_aging_reconciliation` variance = 0).

### Phase 5.4 — Retire `finance_ap_open_items`
After 5.1 leaves no functional caller, drop the view (or keep a thin wrapper pinned
to `CURRENT_DATE` only if a proven dependency remains) and update the architecture
guards that name it.

### Phase 5.5 — Server-side pagination and scale
Add `_limit`/`_offset` plus a server-side total and server-side vendor search to
`get_ap_aging_summary`; the page requests pages instead of slicing. Confirm supporting
indexes on the underlying `journal_entry_lines` / `ap_subledger_entries` predicates
via `EXPLAIN`.

### Phase 5.6 — Export parity guard
Extend `ap-aging-point-in-time.test.ts` to assert the export config is derived from
the same server payload as the table (no second query, no browser recomputation),
and that it carries the as-of date and currency it was produced under.

### Phase 6 — Reconciliation drill-down (next milestone, only after 5.x is green)
Promote `finance_ap_aging_reconciliation` from a header badge to an operator screen
that lists the documents causing any AP subledger ↔ GL variance.

---

## 3. Technical notes

- Bucket boundaries stay single-sourced: `finance_aging_bucket` in SQL, mirrored once
  in `src/services/finance/aging.ts`.
- Aging is against the **due date** (`finance_aging_bucket(p_due_date, p_as_of)`),
  never the bill date — verified in the deployed function.
- No new tables. No new vendor identity model: supplier identity stays
  `contacts` + supplier role. All aggregation stays server-side and SECURITY DEFINER.
- Openness stays residual-derived; `bills.status` / `bills.amount_paid` remain
  forbidden inputs for payables (already enforced by the guard test).
