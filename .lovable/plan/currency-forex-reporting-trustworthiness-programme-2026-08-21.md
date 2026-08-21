# Currency & Forex — reporting trustworthiness programme

Authoritative status file. Update after every implementation step.

## Where we are (re-verified 2026-08-21 by the incoming engineer)

- Step 0 — FX surface lockdown: **COMPLETE (verified)**
- Step 1 — Denomination contract in the posting engine: **COMPLETE (verified)**
- Step 2 — Producer families declare denomination: **COMPLETE (verified)**
- Step 3 — Monetary eligibility + line-level currency: **COMPLETE (verified)**
- Step 4 — Realized FX gain/loss report: **COMPLETE (structurally verified; GL tie-out still unproven)**
- Step 5 — Exposure dimensions (by account, by counterparty): **NOT STARTED**
- Step 6 — Rate register / provenance surface: **LARGELY ALREADY BUILT — plan entry was stale**
- Step 7 — FX control-panel hardening (new, from this verification): **NOT STARTED**

---

## Verification of the previous engineer's claims

VERIFIED FACT (from `pg_proc` / file reads):

- `fx_realized_gain_loss(_business_id, _from, _to)` exists, is SECURITY DEFINER,
  calls `user_can_access_business`, `anon` has no EXECUTE.
- `fx_is_monetary_account`, `fx_exposure_by_currency`, `fx_exposure_open_items`,
  `revalue_fx_balances`, `reverse_fx_revaluation_run`, `fx_revaluation_readiness`,
  `resolve_exchange_rate`, `require_exchange_rate`, `fx_stamp_document`,
  `describe_exchange_rate`, `post_journal_entry_atomic` all exist; none is
  executable by `anon`; the exposure/realized/readiness/describe surfaces are
  business-gated.
- `revalue_fx_balances` scopes on `fx_is_monetary_account` and groups on
  `COALESCE(jel.original_currency, je.currency)` — the Step 3 claim holds.
- A missing rate in revaluation now marks the run `failed` and raises; the old
  silent `CONTINUE WHEN _new_rate IS NULL` is gone.
- `src/hooks/finance/useFxRealized.ts`, `src/pages/reports/FxRealizedReport.tsx`,
  `supabase/tests/fx_revaluation_lifecycle_test.sql`,
  `supabase/tests/journal_denomination_contract_test.sql` all exist.

INVALIDATED / CORRECTED ASSUMPTIONS:

1. **"Step 6 rate register is pending" is wrong.** `src/components/settings/CurrencySettings.tsx`
   (mounted in `src/pages/settings/CompanySettings.tsx`) already renders the rate book with
   `source` / `provider_key` / `published_at` / `effective_date`, writes overrides through
   `set_exchange_rate_override`, and seeds `business_active_currencies` through
   `set_business_active_currency`. What is actually missing from Step 6 is
   **discoverability and parity**, not the surface itself.
2. **Step 4 is claim-complete but tie-out-unproven.** No evidence exists that the report's
   `realized_amount` sum equals net movement on the `resolve_fx_realized_account` accounts.
   Treated as pending verification, not pending build.
3. **Step 5 has not been started.** `useFxExposure` / `FxExposureReport` expose only
   by-currency and open-item dimensions; no account or counterparty dimension exists.

NEW CRITICAL FINDINGS (VERIFIED FACT):

- **F1 — revaluation trusts a client-typed base currency.**
  `revalue_fx_balances(_business_id, _run_date, _base_currency, …)` only `upper()`s
  `_base_currency`; it is never checked against `businesses.base_currency`, and it
  drives both the revaluation scope (`<> upper(_base_currency)`) and the value stamped
  on `fx_revaluation_runs.base_currency`.
  `src/components/finance/FinanceAccountingControls.tsx:307` feeds it from a free-text
  `<Input placeholder="Base currency">`. A typo revalues the wrong population — including
  revaluing the entity's own base-currency balances against themselves.
  *Accounting consequence:* fabricated unrealized gain/loss posted to the GL.
- **F2 — unrealized FX accounts are chosen ad hoc per run.** Realized FX resolves its
  accounts centrally via `resolve_fx_realized_account` (`default_account_settings` keys
  `fx_realized_gain` / `fx_realized_loss`). There are **no** `fx_unrealized_gain` /
  `fx_unrealized_loss` setting keys; the operator picks accounts in a dropdown on every
  run. Two runs can land in different accounts — the same asymmetry the programme exists
  to remove.
- **F3 — a second rate resolver name exists: `resolve_sales_exchange_rate`.** Present in
  `pg_proc` and in migrations. Whether it delegates to `resolve_exchange_rate` or
  re-implements precedence is **UNVERIFIED** and must be settled before Step 5.
- **F4 — the FX operations tab and the rate book live on different pages.** The
  readiness banner says "Add an override in Currency settings" (`/finance/settings` →
  Company Settings) with no link. Operationally the FX control surface is split.

---

## Accounting invariants (unchanged, restated)

1. Denomination is declared by the producer and enforced by `post_journal_entry_atomic`;
   an undeclared foreign posting raises.
2. `override > manual > provider`, latest effective date first — `resolve_exchange_rate`
   only. A missing rate raises or renders as an absence; never 1:1, never a literal.
3. Monetary/non-monetary is decided once, by `fx_is_monetary_account` (IAS 21).
4. Realized FX is created only at settlement, by the settlement engines; every report is
   a projection of what those postings put in the ledger.
5. Unrealized FX belongs to the legal entity, not a branch (`branch_id NULL`).
6. The browser formats; the server resolves, converts and posts.

---

## Execution order (dependency-derived)

### Phase A — Close Step 4's proof gap (no new code unless it fails)
1. Read-only query: for one period with settlements, sum `realized_amount` from
   `fx_realized_gain_loss` and compare to net movement on the accounts
   `resolve_fx_realized_account` returns. Record the numbers in this file.
2. Run `supabase/tests/fx_revaluation_lifecycle_test.sql`,
   `supabase/tests/journal_denomination_contract_test.sql`, and
   `bunx vitest run src/test/architecture/fx-single-engine.test.ts`.
3. End-to-end probe in a scratch business (rolled back): foreign bill + foreign credit
   note, settle one at a different rate, confirm sign and presence in the report.

### Phase B — Resolve F3 before building anything on the resolver
Read `resolve_sales_exchange_rate`'s body. If it delegates, document it and add a guard.
If it re-implements precedence, it is a second engine: collapse it into
`resolve_exchange_rate` and delete the body (no wrapper-with-fallback).

### Phase C — Step 7, FX control-panel hardening (F1, F2, F4)
1. `revalue_fx_balances`: derive base currency from `businesses.base_currency`; if the
   caller passes a different code, raise. Keep the parameter for signature stability.
2. Add `fx_unrealized_gain` / `fx_unrealized_loss` to the default-account settings
   catalogue; resolve them server-side through the same mechanism as the realized pair;
   the run inherits them and the UI shows them read-only with a "configure" link.
3. `FinanceAccountingControls` FX tab: replace the free-text base-currency input with the
   business's base currency (display-only), drop the per-run account pickers, and link the
   missing-rate banner directly to the rate book.
4. Guard: architecture test fails on a free-text currency input in any FX surface and on
   a revaluation caller passing an unvalidated base currency.

### Phase D — Step 5, exposure dimensions
Extend `fx_exposure_by_currency` / `fx_exposure_open_items` with account and counterparty
dimensions reusing `fx_is_monetary_account` and the existing open-item scope. No third
scope rule, no new resolver. Surface as additional groupings on the existing report.

### Phase E — Step 6 completion
Rate-book parity: reachable from the FX tab, provenance columns already present, override
entry already server-validated. Only the discoverability and read-only provenance display
inside the FX tab remain.

---

## Tests required

- `supabase/tests/fx_revaluation_lifecycle_test.sql` — extend with: base-currency mismatch
  raises; unrealized accounts resolved from settings; run inherits them.
- `supabase/tests/journal_denomination_contract_test.sql` — unchanged, must stay green.
- `src/test/architecture/fx-single-engine.test.ts` — extend with: no free-text currency
  input in FX surfaces; single resolver (`resolve_sales_exchange_rate` delegates or is gone).
- Exposure: account/counterparty dimensions must reconcile to the by-currency totals.

## Scope boundaries

In scope: FX rate infrastructure, resolver, stamping, revaluation lifecycle, realized FX,
exposure reporting, and the FX control surfaces named above.
Out of scope: reporting engine rewrites, unrelated finance modules, cosmetic work, any
second FX engine or client-side rate maths.

## Execution status

Phases A–E all pending. Nothing implemented by the incoming engineer yet.
