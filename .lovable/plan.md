# FX Source & Consumption Architecture — active plan and status log

Authoritative status. Update this file after every implementation step.

Governing decisions: ADR 0135 (supplier currency is a proposal default),
ADR 0136 (one FX engine; a missing rate is a visible absence, never 1:1),
ADR 0123 (single journal posting monopoly).

---

## Currently active phase

**Phase 8 — Collapse the redundant FX engines.** Steps 1–4 complete and verified.
Step 5 (guard ratchets for the newly converged surface) is the next task.

---

## Phase status

### Phases 1–7 — COMPLETE (verified in earlier sessions)
One rate book (`public.exchange_rates`), one server resolver
(`resolve_exchange_rate` / `require_exchange_rate`), one client lookup
(`@/services/fx/rateBook`), AP stampers delegating to `fx_stamp_document`,
revaluation (`revalue_fx_balances`, `reverse_fx_revaluation_run`,
`fx_revaluation_readiness`) and FX exposure reporting.

### Phase 8 — Collapse the redundant FX engines (ACTIVE)

- **Step 1 — `to_base_amount` — DONE, verified.**
  Rewritten to call `resolve_exchange_rate`, so override > manual > provider
  precedence and business-scoped rows apply. Its silent `ELSE _amount`
  (1:1 parity) fallback is gone: a missing rate returns NULL. Access is gated on
  `user_can_access_business`; EXECUTE revoked from `PUBLIC` and `anon`.
  Verified: `proacl` shows `authenticated` + `service_role` only.

- **Step 2 — callers adapted to the NULL contract — DONE, verified.**
  - `finance_ap_vendor_credit_as_of`: previously `SUM(to_base_amount(...))`,
    which silently skipped NULL components and understated an apparently
    complete total. Now a currency group with any unrated row returns
    `base_credit_amount = NULL`.
  - `finance_ar_customer_credit_as_of`: already propagates NULL per row
    (no aggregate over the conversion) — no change needed.
  - `raise_ar_dispute` and `record_promise_to_pay`: write paths whose base
    columns are NOT NULL. They now refuse with `23514` and a message pointing
    at Currency settings instead of storing a parity-converted figure.
  - `src/services/finance/openItems.ts`: row types are `number | null`;
    unrated rows are excluded from base-currency totals. Removed the
    `base_credit_amount ?? credit_amount` fallback in
    `fetchPayableCounterparties`, which was a silent 1:1 conversion of a
    foreign credit into the base-currency net.
  Verified: `tsgo -p tsconfig.app.json` clean, build OK.

- **Step 3 — 3PL billing private lookup removed — DONE, verified.**
  `_wms_generate_3pl_invoice_internal` no longer queries `exchange_rates`
  itself (its own query ignored source precedence and business-scoped rows).
  It calls `require_exchange_rate`, so it raises rather than billing at an
  unresolved rate.

- **Step 4 — provenance lookup converged — DONE, verified.**
  New internal `_pick_exchange_rate_row(org, business, currency, base, date)`
  holds the precedence ordering once. `resolve_exchange_rate` and
  `describe_exchange_rate` both delegate to it; `describe_exchange_rate` keeps
  its `user_can_access_business` gate. EXECUTE on the picker is revoked from
  `PUBLIC`, `anon` and `authenticated` (service_role only).
  Verified: a catalogue sweep of every `public` function shows
  `_pick_exchange_rate_row` is now the **only** function that reads
  `public.exchange_rates`.

- **Step 5 — guard ratchets — PENDING (next task).**
  Extend `src/test/architecture/fx-single-engine.test.ts` (and add a SQL
  invariant test) so CI fails on: a new SQL function selecting from
  `exchange_rates` outside `_pick_exchange_rate_row`; a reintroduced
  `COALESCE(..., 1)` / `ELSE _amount` parity fallback in any conversion
  helper; a client-side `?? credit_amount`-style substitution of a foreign
  amount for a missing base amount.

### Phase 9 — Realized FX on settlement — PENDING
Realized FX is missing from single-invoice settlement paths
(`record_payment_atomic`) and from settlement reversals. Bring them onto the
same resolver and the existing realized-FX account resolution
(`resolve_fx_realized_account`), with reversal symmetry.

### Phase 10 — Tenant-facing absence states — PENDING
Audit the surfaces that now receive NULL (vendor/customer credit totals,
counterparty nets, dispute and promise forms) and render an explicit
"no rate on file" state linking to the rate book, per ADR 0136 — instead of
a blank or an implicit zero.

### Phase 11 — Security and lifecycle hardening — PENDING
Extend `supabase/tests/fx_revaluation_lifecycle_test.sql` with the new
contracts (picker-only rate reads, NULL propagation, write-path refusal) and
close the cross-business execute surface on the remaining FX helpers.

---

## Notes for the next agent

1. **Verify before extending.** Confirm Steps 1–4 hold: (a) only
   `_pick_exchange_rate_row` reads `public.exchange_rates` (catalogue sweep of
   `pg_get_functiondef` across `public`); (b) `to_base_amount`,
   `resolve_exchange_rate` and `describe_exchange_rate` carry no parity
   fallback and no `anon` EXECUTE; (c) `openItems.ts` has no
   `?? credit_amount` substitution.
2. **Then resume at Phase 8 Step 5**, not elsewhere. Ratchets belong with the
   convergence they protect; Phase 9 starts only once Phase 8 is closed.
3. **Live data caveat:** `exchange_rates` holds base-currency rows only, so the
   foreign-currency paths are correct by construction and by SQL tests, but have
   not yet been exercised against real multi-currency tenant data. Seeding a
   foreign rate plus one foreign document is the cheapest way to exercise
   Phases 8–10 end to end.
4. **Linter baseline is 3599 issues** (pre-existing, dominated by the
   SECURITY DEFINER execute-surface warnings). Treat any increase as caused by
   your change; the FX work has not increased it.
