# ADR 0135 — Supplier currency is a proposal default, not a denomination

Status: Accepted
Date: 2026-08-12
Related: ADR-0079 (party vs role), ADR-0123 (single journal posting monopoly)

## Context

`suppliers.default_currency` was unconstrained free text (no FK, no CHECK, no default)
edited through a plain three-character text input, and **nothing read it**. Purchase
orders and bills stamped `businesses.base_currency` directly; the only reader,
`resolve_supplier_defaults`, had no call sites. The field was dead domain metadata.

The investigation also found the real hazard underneath it:

- `public.exchange_rates` is empty and only an AR-side resolver existed
  (`resolve_sales_exchange_rate`, used by three sales RPCs). Purchasing had **no** rate
  resolution at all.
- Purchasing headers carried literal defaults (`'USD'` on bills / POs / vendor credit
  notes, `'KES'` on purchase returns) that ignore the business base currency, so a
  foreign-currency bill kept `currency_rate = 1` and posted 1:1 into the ledger silently.

## Decision

1. **Canonical representation stays the ISO code as `text`.** `public.currencies` is the
   catalogue; no transactional table gains a `currency_id`. Integrity comes from
   validation against the catalogue, not from a FK rewrite of every money table.
2. **Supplier currency is a proposal default only.** It seeds a new PO / bill / credit
   note at creation time and is then snapshotted onto the document. Documents never
   re-read it, so changing a supplier's default currency can never re-denominate history.
   Resolution order: `suppliers.default_currency → contacts.default_currency →
   businesses.base_currency`.
3. **One rate resolver.** `public.resolve_exchange_rate(org, business, currency, date)`
   serves AR and AP. `resolve_sales_exchange_rate` is now a thin shim over it. It returns
   `NULL` when no rate is on file and never invents `1`.
   `public.require_exchange_rate(...)` is the strict wrapper used by document triggers: it
   raises rather than posting an unconverted foreign amount.
4. **Headers derive, they do not hardcode.** The `'USD'` / `'KES'` column defaults on
   `bills`, `purchase_orders`, `vendor_credit_notes` and `purchase_returns` are dropped.
   `BEFORE` triggers fill the currency from the base currency when absent, validate the
   code against `currencies`, and stamp the rate (and `exchange_rate_date` for vendor
   credit notes) from the resolver.
5. **Posted documents are frozen.** Once a posted journal entry exists for a bill or
   vendor credit note, its currency and rate are immutable.
6. **No second FX engine.** Module-local conversion and client-side FX math are banned;
   the browser may display a resolved rate but never compute one.

## Consequences

- Invalid supplier / contact currency codes (`'banana'`, inactive codes) are rejected at
  the database boundary; codes are normalised to upper case.
- A foreign-currency purchasing document now fails loudly when the organisation has no
  rate on file, instead of quietly posting at 1:1. Populating `exchange_rates` becomes a
  prerequisite for multi-currency purchasing — that is the intended contract.
- The vendor-credit-note currency inconsistency (literal `'USD'`, null `exchange_rate` /
  `exchange_rate_date`) is closed by the same trigger; it was an independent instance of
  the pattern, not a consequence of the supplier field.
- The supplier form uses the canonical `CurrencyCombobox` backed by `public.currencies`,
  the same picker Contacts already uses.