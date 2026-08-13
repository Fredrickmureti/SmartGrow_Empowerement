# Aged Payables (AP Aging) — Handover Verification Verdict & Continuation Plan

Last updated: 2026-08-13 (15:10 EAT). Owner workstream: **AP aging domain reconstruction**.
This file replaces the previous status document. Section 1 is the independent verdict on the
previous engineer's claims; Sections 3+ are the remaining work in dependency order.

---

## 1. Verification verdict (evidence-based, this turn)

Method: live introspection of the database (`pg_proc`, function bodies, privileges), plus
direct reading of the shipped hook, page, services and guard tests. No claim was accepted on
the strength of the previous status file.

| Claim | Verdict | Evidence |
|---|---|---|
| Phase 1 — `finance_ap_open_items_as_of` point-in-time engine on `ap_subledger_entries` | **Confirmed** | Function exists, PL/pgSQL, `STABLE SECURITY DEFINER`, `search_path=public`; obligations gated by a posted AP subledger entry `<= as_of`; payments bounded by `payment_date <= as_of` and void date; vendor credits bounded by applied/credit date and `reversed_at`; residual-based openness |
| Phase 1 — `finance_ap_vendor_credit_as_of` | **Confirmed** | Exists with identical scope/guard signature |
| Phase 2 — `get_ap_aging_summary` / `get_ap_summary` rebuilt on the engine | **Confirmed** | Both exist, guarded, single overload each |
| Phase 3 — `finance_ap_aging_reconciliation` | **Confirmed** | Consumed by the hook and rendered as a variance badge |
| Phase 4 — typed hook + rebuilt page, no browser arithmetic | **Confirmed** | `src/hooks/useApAging.ts` maps server payload only; page renders `totals.*` verbatim; buckets come from SQL |
| Phase 5.0 — auth hardening, `finance_can_read_org`, anon revoked | **Confirmed, with one hole** | The four AP functions: `prosecdef=true`, guard present, `anon` execute = false. **But `get_ar_ap_aging_from_ledger` is `SECURITY DEFINER` with NO `finance_can_read_org` guard** |
| Phase 5.1 — consumer convergence, no `finance_ap_open_items` readers left | **Confirmed** | Only the generated `types.ts` still mentions the deprecated view; all services and the PDF path call the as-of RPC |
| Phase 5.5 — server-side pagination, single 7-arg overload | **Confirmed** | Exactly one `get_ap_aging_summary` overload (7 args); hook exposes `search/limit/offset`; export re-fetches with `limit: null` |
| Phase 5.2/5.3 — scenario fixtures A–J executed | **NOT verified — still pending** | The fixture file exists (328 lines) but this environment has no `psql`/`PGHOST`, and the DB tooling available is read-only, so behavioural assertions inside a transaction cannot be run. Additionally the connected database currently holds **zero bills, zero bill payments and zero AP subledger rows**, so no live data can corroborate the engine either |
| Phase 5.6 — export parity guard | **Correctly reported as pending** | No assertions in `ap-aging-point-in-time.test.ts` covering export rows |

### New defects found during verification (not in the previous plan)

1. **FX rate literal in the engine.** `finance_ap_open_items_as_of` computes
   `COALESCE(NULLIF(b.currency_rate, 0), 1)` as the exchange rate. A silent 1:1 fallback
   directly violates the project's canonical FX rule (missing rate must be null/`—`, never a
   literal). A foreign-currency bill with no snapshot rate is currently reported at face value
   in base currency, understating or overstating payables with no signal.
2. **Unguarded shared aging RPC.** `get_ar_ap_aging_from_ledger` is `SECURITY DEFINER`, pins
   `search_path`, but performs no organisation membership check — it is the AR/AP report used
   by `AgingReport.tsx`. This is a cross-organisation read risk and an inconsistency with the
   hardening applied to the other four functions.
3. **Manual-journal AP rows are never settled.** The `manual_rows` branch hardcodes
   `paid_amount = 0` and `credited_amount = 0`. A payment posted against a manual AP journal
   line stays in aging forever. Aging and the AP control account will drift the moment a
   manual AP accrual is paid.
4. **Test suite cannot run in this sandbox.** `vitest`/`tsgo` binaries are not installed in
   `node_modules`, so the guard tests were verified by reading them, not by execution. First
   action in build mode is to install and run them.

---

## 2. What this means

The accounting core the previous engineer built is real and architecturally sound: one
point-in-time AP engine over the subledger, GL-gated, residual-based, branch-scoped,
server-aggregated, with all consumers converged onto it. The gaps are **proof** (nothing was
executed) and **three correctness defects** at the edges of the engine (FX fallback, manual
journal settlement, one unguarded RPC).

No new aging engine, dataset, allocation engine or vendor identity model is needed.

---

## 3. Remaining work, in dependency order

### Phase 6 — Prove what exists (blocking; nothing else ships first)
- Install dev dependencies; run `ap-aging-point-in-time`, `ap-aging-scenario-fixtures`,
  `ap-aging-server-pagination`, `customer-statement-dataset-parity`, plus
  `tsgo --noEmit -p tsconfig.app.json`. Fix whatever fails.
- Execute `supabase/tests/ap_aging_as_of_test.sql`. Where the sandbox cannot run a
  transactional fixture, convert the contract assertions (single overload, definer + pinned
  search_path + org guard, no `anon` execute, no `amount_paid` in the report path) into
  read-only checks that can be executed here, and keep the behavioural A–J scenarios in the
  SQL fixture for CI.
- Acceptance: every scenario A–J passes, or its failure is recorded and fixed.

### Phase 7 — Engine correctness defects (from §1)
- **7a FX honesty.** Remove the `, 1)` fallback. When a foreign-currency bill has no snapshot
  rate, resolve through the canonical rate authority for the as-of date; if unresolvable,
  return `base_residual_amount = NULL` and surface `—` in the UI and exports rather than a
  fabricated base amount. Guard test pins the absence of any rate literal in the AP engine.
- **7b Manual-journal settlement.** Net payments/credits posted against manual AP journal
  documents into `manual_rows` (settlement rows in `ap_subledger_entries` keyed to the same
  journal/contact), so a paid accrual leaves aging. Add a scenario to the fixture.
- **7c Authorization parity.** Add `finance_can_read_org` to `get_ar_ap_aging_from_ledger`,
  revoke `PUBLIC`/`anon`, grant `authenticated`/`service_role`. Extend the guard test to
  assert every finance reporting RPC in this family is guarded.
- Acceptance: `finance_ap_aging_reconciliation` variance is zero for a seeded book containing
  a paid manual AP accrual and an unrated foreign-currency bill.

### Phase 8 — Export parity (previously "5.6")
- Assert in the guard test that export rows and screen rows originate from the same RPC, that
  the export performs no browser bucket/total recomputation, and that the grand-total row uses
  the server `totals` payload.

### Phase 9 — Reconciliation surface (first-class)
- Promote `finance_ap_aging_reconciliation` from a header badge to an operator screen:
  aging total vs AP control balance for the as-of date, with variance drill-down naming the
  documents that cause it (subledger rows with no aging row, and vice versa).
- Acceptance: an accountant can go from a non-zero variance to the offending document in two
  clicks; Aged Payables, Vendor Statement closing balance and the AP control account agree for
  the same supplier, branch and date.

### Phase 10 — Legacy retirement
- Drop the deprecated `finance_ap_open_items` view once Phase 6 proves no reader remains, and
  regenerate types. Remove any dead AP aging RPCs the audit surfaces.

---

## 4. Technical notes

- Bucket boundaries stay single-sourced: `finance_aging_bucket` in SQL, mirrored once in
  `src/services/finance/aging.ts`. Aging is measured against **due date**, not bill date.
- Supplier identity stays `contacts` + supplier role (ADR-0079). No vendor identity model.
- All aggregation stays server-side, `SECURITY DEFINER`, org-guarded. No new tables.
- Currency: document currency is authoritative; base currency is a presentation projection
  that must be honest about missing rates (ADR 0135/0136).

## 5. Out of scope

No new domains until Phase 10 closes. No UI added without its server contract.
