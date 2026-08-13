---
name: Currency representation and FX resolution
description: ADR 0135 + 0136 + 0138 — ISO code text wire format, one rate book with override>manual>provider precedence, server-only booking/settlement rates, single client lookup rateBook.ts, missing rate renders as an absence, FX exposure report is a projection of the one resolver
type: feature
---

# Currency & FX

- Canonical catalogue is `public.currencies` (ISO code). Transactional tables store the
  **ISO code as `text`** — never a `currency_id` FK. Integrity via
  `public.normalize_currency_code` + triggers.
- `suppliers.default_currency` / `contacts.default_currency` are **proposal-time defaults
  only**: supplier → contact → `businesses.base_currency`, snapshotted onto the document.
  Client entry point `useSupplierDocumentCurrency`; never hardcode a currency literal.
- **One rate book**: `public.exchange_rates`, with provenance (`source`, `provider_key`,
  `published_at`, `created_by`). Provider market data lives in `platform_exchange_rates`
  and is bridged by the server-side scheduled `publish_platform_rates()`.
- **One precedence**: `override > manual > provider`, latest effective date first —
  `public.resolve_exchange_rate`, strict wrapper `public.require_exchange_rate`.
- **One client lookup**: `@/services/fx/rateBook` (`resolveRateFromBook`/`convertWithBook`).
  `CurrencyContext` and `useTenantFx` are thin readers over it. Display only — the browser
  never computes a posted amount. A missing rate is `null` and renders as `—`; nothing
  returns 1 for an unknown pair and no rate literals are allowed anywhere.
- Tenant-entered rates insert `source = 'override'`; they never mutate provider rows.
- Documents snapshot currency + rate via `fx_stamp_document` triggers; posted documents are
  immutable. Realized FX gain/loss is posted at settlement by
  `record_multi_invoice_payment` / `record_multi_bill_payment` (ADR 0123 posting monopoly).
- **Unrealized**: `revalue_fx_balances` (+ `reverse_fx_revaluation_run`,
  `fx_revaluation_readiness`) is the only revaluation engine.
- **Exposure (pre-revaluation view)**: `fx_exposure_by_currency` /
  `fx_exposure_open_items` → `useFxExposure` → `/finance/reports/fx-exposure`. Read-only
  projection over the same resolver and the same open-balance scope as revaluation; the
  browser formats only. A currency with no rate shows "No rate on file" (ADR 0138).
- Reversal approval gating is generic for every reversible document, vendor credit notes
  included: `reversal_approval_requirement` → `assert_can_reverse` →
  `request_reversal_approval`. No document type gets a bespoke gate.
- Guards: `src/test/architecture/currency-integrity.test.ts`,
  `src/test/architecture/fx-single-engine.test.ts`,
  `src/test/architecture/reversal-intent-policy.test.ts`.
  Authority: ADR 0135, ADR 0136, ADR 0138.

## Landed cost (audited 2026-08-13)

- `landed_cost_vouchers.currency` must be an **active** code from `public.currencies`;
  no schema default, no free text. UI picks it with the shared `CurrencyCombobox` +
  `useCurrencies`; the default is the business base currency.
- `_landed_cost_voucher_fx_stamp` (BEFORE INSERT/UPDATE) stamps `currency`,
  `exchange_rate`, `exchange_rate_date` through `fx_stamp_document` →
  `require_exchange_rate`. **Any rate sent by the browser is ignored.** Missing rate
  raises. Currency/rate/rate-date are immutable once `posted` or `reversed`; changing
  them on a draft re-values components via `_landed_cost_voucher_revalue_components`.
- No `COALESCE(exchange_rate, 1)` anywhere in the landed cost path — allocation and
  component sync raise instead of valuing at parity.
- Create page displays provenance via `describe_exchange_rate` only (source +
  effective date); it never converts an accounting amount.
- Guards: `src/test/architecture/landed-cost-currency.test.ts`,
  `supabase/tests/landed_cost_currency_fx_test.sql`.
