---
name: Currency representation and FX resolution
description: ADR 0135 — ISO code text wire format, supplier currency is a proposal default, resolve_exchange_rate/require_exchange_rate are the only rate authorities, purchasing headers derive currency from triggers
type: feature
---

# Currency & FX

- Canonical catalogue is `public.currencies` (ISO code). Transactional tables store the
  **ISO code as `text`** — never a `currency_id` FK. Integrity is enforced by validation
  (`public.normalize_currency_code`) and triggers, not FKs.
- `suppliers.default_currency` / `contacts.default_currency` are **proposal-time defaults
  only**. They seed a new PO / bill / vendor credit note and are snapshotted onto the
  document; documents never re-read them, so editing a supplier cannot re-denominate
  history. Order: supplier → contact → `businesses.base_currency`.
- Client entry point: `useSupplierDocumentCurrency` (calls `resolve_supplier_defaults`).
  Purchasing create pages must not hardcode a currency literal.
- **One rate authority**: `public.resolve_exchange_rate(org, business, currency, date)`
  (returns NULL when no rate on file — never invents 1) and the strict wrapper
  `public.require_exchange_rate` used by document triggers.
  `resolve_sales_exchange_rate` is a shim over it. No client-side FX arithmetic.
- Purchasing headers have **no literal column defaults**; `_tg_stamp_*_currency` triggers
  fill/validate the currency and stamp the rate. Posted bills and vendor credit notes have
  immutable currency and rate.
- `public.exchange_rates` is empty — multi-currency purchasing requires seeding it, and
  will fail loudly (by design) until then.
- Guard: `src/test/architecture/currency-integrity.test.ts`. Authority: ADR 0135.