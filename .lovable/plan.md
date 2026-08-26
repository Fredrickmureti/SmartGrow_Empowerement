# Currency Architecture Remediation — authoritative status

Baseline audit: `docs/audits/currency-architecture-audit.md`.
This file is the single source of truth for where the remediation stands.

## Phase status

| Phase | Scope | Status |
| --- | --- | --- |
| 1–5 | FX engine, rate resolution, stamping, transactional documents | Done (verified in earlier waves) |
| 6 | Fixed assets: DB currency + rate stamping, depreciation/GL on base amounts | Done, verified |
| 6 | Fixed assets UI: list, depreciation report, create/edit form, peek, schedule dialog | **Done this wave** |
| 7 | Presentation convergence (D12, D14): one catalogue-driven formatter | **Done this wave** |
| 8 | Currency Settings UX | **Done this wave** |
| 9 | Regression protection: D15 revaluation concurrency, S2, architecture tests | **NEXT** |

## Completed this wave

### Phase 6 completion — fixed-asset UI
- `AssetFormBody.tsx` carries a `currency` field with a catalogue-driven selector
  (enabled business currencies, defaulting to base) and an `acquisitionLocked` mode.
- `AssetCreatePage.tsx` / `AssetEditPage.tsx` send `currency` only — never a rate,
  never a base amount; the trigger stamps those. Edit freezes the acquisition
  measurement once the asset is depreciated or disposed, and explains why.
- `assetCurrencyError.ts` turns the `23514` "no exchange rate on file" refusal and the
  immutability refusals into actionable finance-user messages.
- `src/pages/FixedAssets.tsx`: KPI totals `base_purchase_price`; per-row purchase price
  renders in the asset's own currency with the base equivalent and stamped rate.
- `src/pages/reports/DepreciationReport.tsx`: selects and totals
  `base_purchase_price` / `base_residual_value` — a base-currency report throughout.

### Phase 7 — presentation convergence
- New catalogue as the only source of currency presentation facts:
  `src/lib/currency/catalogue.ts` (client) and
  `supabase/functions/_shared/format/catalogue.ts` (edge mirror). Holds ISO 4217 minor
  units, seed symbols, `setCurrencyCatalogue` / `loadCurrencyCatalogue` hydration from
  the `currencies` table, `getCurrencyDecimals`, `getCurrencyPrefix`,
  `formatCurrencyDigits`.
- Removed the hardcoded symbol map and the hardcoded 2dp policy from
  `src/design-system/reports/format.ts`, `supabase/functions/_shared/format/currency.ts`,
  `src/lib/reports/currencyPresentation.ts` and
  `supabase/functions/_shared/reports/currencyPresentation.ts`. Zero-decimal (JPY, RWF)
  and three-decimal (KWD, BHD) currencies now render correctly in reports, ledger FX
  supplements and PDFs.
- Hydration wired: `CurrencyContext` installs the tenant catalogue on fetch;
  `process-scheduled-reports` and `generate-document` load it before rendering.
- `src/pages/reports/LotTraceabilityReport.tsx` moved off `formatCurrency` onto
  `formatAccountingNumber`, so screen and PDF agree on negatives and minor units.
- `report-format-parity.test.ts` rewritten: asserts client/edge catalogue sections are
  byte-identical, that no module re-introduces a private symbol map or a 2dp constant,
  and that fixtures render with per-currency minor units.

### Verification run this wave
- `tsgo --noEmit` clean.
- `report-format-parity`, `reports-single-engine`, `ledger-reports-single-source`: 27/27 green.
- Pre-existing, unrelated failures remain in the wider suite (WMS RPC grants,
  balance-sheet statement builders returning NaN). They predate this wave and are not
  currency-presentation defects.

## Phase 8 — Currency Settings UX (this wave)

Verified already present and correct in `src/components/settings/CurrencySettings.tsx`:
- Base currency card driven by `business_currency_readiness` (ready / confirmation_required /
  locked), changed only through `change_business_base_currency` with a mandatory reason.
- Operating currencies via `list_business_active_currencies` / `set_business_active_currency`;
  the base row cannot be switched off.
- Rate book listing with provenance (source, provider key, effective and published dates),
  append-only — no edit or delete path; corrections are new dated overrides written by
  `set_exchange_rate_override`.

Added this wave — the missing coverage indicator called for in
`docs/finance/fx-rate-coverage.md`:
- `src/hooks/useFxRateCoverage.ts` — read-only reader over `fx_rate_coverage_summary`.
  No client arithmetic; every status is server-computed.
- `src/components/settings/FxRateCoverageCard.tsx` — per-currency usage, coverage extent,
  latest rate with provenance, uncovered-document count and status badge
  (none / partial / stale / covered), plus provider-snapshot age and last publish time.
- Wired into `CurrencySettings` above the Rate Book. "Record rate" opens the override
  dialog pre-aimed at the gap (currency + earliest uncovered date); saving an override
  refreshes both the rate book and coverage.

Also corrected `src/test/architecture/fx-single-engine.test.ts`: it asserted that
`CurrencyContext` contained a literal `source: "override"`, which stopped being true when
the write moved to the `set_exchange_rate_override` RPC. It now asserts the RPC call and
that the browser never inserts into `exchange_rates` directly — the stronger invariant.

Verification: `tsgo --noEmit` clean; `fx-single-engine` 31/31 and `currency-integrity`
green.

## Next: Phase 9 — regression protection
- D15: revaluation concurrency (`revalue_fx_balances` / `reverse_fx_revaluation_run`
  must not interleave into double postings).
- S2 from the audit.
- Architecture tests that fail the build if any new module hardcodes a currency symbol,
  a decimal count, or a `COALESCE(rate, 1)`.

## Instructions for the next agent
1. **Verify before continuing.** Confirm, do not assume: catalogue hydration fires in
   both runtimes (client context and both edge functions), no module has re-added a
   symbol map or `minimumFractionDigits: 2` for money, the fixed-asset form still cannot
   send a rate or a base amount, and Currency Settings writes rates only through
   `set_exchange_rate_override` while reading coverage only from
   `fx_rate_coverage_summary`.
2. Then resume at **Phase 9** — do not jump to unrelated modules.
3. Keep the invariants: one FX engine, no client-side conversion, no
   `COALESCE(rate, 1)`, formatting never inside arithmetic, stamped rates immutable.
4. Update this file at the end of each wave so it stays authoritative.
