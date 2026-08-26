# Currency Architecture Remediation — Phase 6 completion (fixed assets UI) then Phase 7

Baseline: `docs/audits/currency-architecture-audit.md`. Authoritative status carried forward from
`.lovable/plan/currency-architecture-remediation-authoritative-project-stat-2026-08-26.md`.
This file supersedes the stale copy that still showed Phase 5 as "NEXT".

## Verification of the handover (done before planning)

Checked directly, not taken on trust:

- **Database (D6) — confirmed.** `fixed_assets` carries `currency`, `acquisition_exchange_rate`,
  `base_purchase_price`, `base_residual_value` (all NOT NULL) and nullable
  `disposal_exchange_rate`, `base_disposal_price`.
- **Hooks — confirmed rewired.** `useFixedAssets.ts`, `useDepreciationRun.ts`,
  `useDepreciationSchedule.ts` all read `base_purchase_price` / `base_residual_value` for
  depreciation, carrying value, GL postings and totals; disposal reads back
  `base_disposal_price`.
- **UI — confirmed still pending.** `src/pages/FixedAssets.tsx` totals raw `purchase_price` and
  renders every amount in base currency; `src/pages/reports/DepreciationReport.tsx` selects
  `purchase_price` / `residual_value`; the asset form (`AssetFormBody.tsx`, `AssetCreatePage.tsx`,
  `AssetEditPage.tsx`) has no currency field.
- **Additional consumers the handover did not mention** (found by tracing, now in scope):
  `src/features/finance/fixed-assets/AssetPeekSheet.tsx` and
  `src/components/assets/DepreciationScheduleDialog.tsx` also format `purchase_price` as base
  currency.
- `formatCurrency(amount, currencyCode?)` already accepts an explicit currency — no formatter work
  needed for this wave.
- **The tree does not currently typecheck.** `AssetCreatePage.tsx(24)` fails TS2345: the hook's
  create payload now requires `currency`, and the form does not supply it. This is a live break
  left by the partial handover, and item 3 below is what fixes it — so this wave must be
  implemented before anything else can ship.

## Phase 6 status

| Item | Status |
| --- | --- |
| D6 — fixed-asset currency + acquisition/disposal rate stamping (DB) | Done, runtime-verified |
| D6 — depreciation/GL hooks on base amounts | Done |
| D6 — fixed-asset UI (list, report, form, peek, dialog) | **This wave** |
| D7 — budget currency | Verified already correct (`_budgets_defaults` forces base currency); no change |

## This wave — scope

Presentation and read paths only. No schema change, no trigger change, no accounting arithmetic
change, no client-side conversion, no rate ever sent from the client.

1. `src/pages/FixedAssets.tsx`
   - KPI "total value" sums `base_purchase_price` (base currency — mixed-currency sums are only
     valid in base).
   - Per-row purchase price renders in the asset's own currency:
     `formatCurrency(asset.purchase_price, asset.currency)`.
   - Book value / accumulated depreciation stay base currency (they are derived base amounts).
2. `src/pages/reports/DepreciationReport.tsx`
   - Select and total `base_purchase_price` / `base_residual_value`; the report stays a
     base-currency report, header currency unchanged.
3. `src/features/finance/fixed-assets/AssetFormBody.tsx` + `AssetCreatePage.tsx` /
   `AssetEditPage.tsx`
   - Add a catalogue-driven currency selector (enabled business currencies, default base).
   - The form sends `currency` only. It never sends `acquisition_exchange_rate`,
     `base_purchase_price` or `base_residual_value` — the trigger stamps those.
   - On edit, currency is disabled once the asset is depreciated or its acquisition posted (the
     database already refuses; the UI must explain rather than let it fail).
   - Surface the `23514` "no exchange rate on file" refusal as an actionable message.
4. `AssetPeekSheet.tsx` and `DepreciationScheduleDialog.tsx`
   - Purchase price in asset currency; depreciation/book value in base currency; show the stamped
     acquisition rate as provenance where a foreign currency is involved.

## Must not change

- `trg_fixed_assets_stamp_currency` / `_tg_stamp_fixed_asset_currency`, `fx_stamp_document`,
  `resolve_exchange_rate`, `_pick_exchange_rate_row`.
- Any stamped rate, posted amount, GL entry or closed period.
- Budget currency behaviour (already correct).
- No `COALESCE(rate, 1)`; no client-side FX arithmetic; formatting stays out of arithmetic.

## Validation

- `tsgo --noEmit`.
- Fixed-asset and currency-architecture test suites.
- Read-only DB check that no new client write path can supply a rate.

## Next after this wave

**Phase 7 — presentation convergence (D12, D14):** one catalogue-driven formatter
(`decimal_places`, `symbol`); remove the hardcoded 2dp and symbol map from
`src/design-system/reports/format.ts` and `currencyPresentation.ts`; zero-decimal currencies
correct in reports and PDFs; optional `en-IN` grouping, presentation only.
Then Phase 8 (Currency Settings UX) and Phase 9 (regression protection: D15 revaluation
concurrency, S2, architecture tests).
