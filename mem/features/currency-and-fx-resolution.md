---
name: Currency representation and FX resolution
description: ADR 0135 + ADR 0136 — ISO code text wire format, one rate book with override>manual>provider precedence, server-only booking/settlement rates, single client lookup rateBook.ts, missing rate renders as an absence
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
- Guards: `src/test/architecture/currency-integrity.test.ts`,
  `src/test/architecture/fx-single-engine.test.ts`. Authority: ADR 0135, ADR 0136.
