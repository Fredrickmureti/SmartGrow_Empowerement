# Landed Cost — currency & FX forensic audit, then correction

## What I verified (all confirmed against the live database and working tree)

**Monetary lifecycle as it exists today**

```text
LandedCostCreatePage (browser)
  currency  = free-text <Input>, seeded from currentBusiness.base_currency ?? "KES"
  exchange_rate = read from useTenantFx (display rate book), OPERATOR-EDITABLE
        ↓ direct client INSERT into landed_cost_vouchers
landed_cost_vouchers.currency (text, DEFAULT 'KES', no FK, no normalize trigger)
landed_cost_vouchers.exchange_rate (numeric, DEFAULT 1)
        ↓ trigger _landed_cost_component_sync
base_amount = ROUND(amount * COALESCE(voucher.exchange_rate, 1), 2)
        ↓ landed_cost_allocate_voucher
allocated_amount derived from  amount * COALESCE(v_voucher.exchange_rate, 1)
        ↓ landed_cost_post_voucher
inventory_apply_cost_revaluation(...)  → inventory valuation in base currency
        ↓ journal lines: Inventory / COGS debit, landed_cost_clearing credit
```

**Findings**

1. `landed_cost_vouchers.currency` is `text` with `DEFAULT 'KES'` — a hardcoded currency literal in the schema. There is **no** FK to `public.currencies`, **no** `normalize_currency_code` trigger, and **no** `fx_stamp_document` trigger on the table. Arbitrary strings can be persisted.
2. The currency field is **not decorative** — it is worse. It has economic meaning only via `exchange_rate`, and that rate is **supplied by the browser** on insert. The client computes the number that ends up capitalised into inventory and posted to the GL. This violates ADR 0136 §4 (display-only client) and the posting monopoly boundary.
3. Two explicit silent 1:1 fallbacks exist in the accounting path: `COALESCE(v_voucher.exchange_rate, 1)` in `_landed_cost_component_sync` and again in `landed_cost_allocate_voucher`. Combined with `exchange_rate DEFAULT 1`, a foreign-currency voucher can post at parity.
4. The canonical server resolver `resolve_exchange_rate` / `require_exchange_rate` and the document stamper `fx_stamp_document` (which normalises the code, falls back to `businesses.base_currency`, and raises when no rate is on file) **exist and are used by other documents — landed cost calls none of them.**
5. No landed-cost-specific FX function, currency list or provider call exists. The module has no duplicate FX engine to remove — it is simply *disconnected*. Platform rates and tenant overrides therefore reach landed cost only by accident of what the browser happened to read.
6. A canonical searchable picker already exists: `CurrencyCombobox` (`src/components/contacts/CurrencyCombobox.tsx`) over `useCurrencies()` reading `public.currencies` where `is_active`. Nothing new needs to be built.

**Verdict:** landed cost is not a first-class participant in the canonical monetary architecture. The UI free-text field is a symptom; the defect is that the browser supplies the booking rate and the database defaults it to 1.

## The fix

### 1. Database — make the rate server-authoritative (migration)

- Drop the `'KES'` default on `landed_cost_vouchers.currency`; add a `normalize_currency_code` + `currencies` validation trigger so only a canonical active ISO code can be stored.
- Add a BEFORE INSERT/UPDATE trigger that calls `fx_stamp_document(organization_id, business_id, currency, COALESCE(exchange_rate_date, voucher_date))` and stamps `currency`, `exchange_rate`, `exchange_rate_date` from the server resolver — **ignoring any rate the client sends**. Missing rate ⇒ `require_exchange_rate` raises, and the draft is refused with an explicit message.
- Freeze the contract after posting: reject changes to `currency` / `exchange_rate` / `exchange_rate_date` once `status` is `posted` or `reversed`, so historical vouchers keep their original rate. Re-stamping only happens while the voucher is a draft.
- Remove both `COALESCE(..., 1)` fallbacks in `_landed_cost_component_sync` and `landed_cost_allocate_voucher`; a null rate must raise, never silently become parity. `exchange_rate` becomes `NOT NULL` with no default.

### 2. UI — canonical selection, read-only rate

- Replace the free-text currency `<Input>` in `LandedCostCreatePage` with the existing `CurrencyCombobox` + `useCurrencies()`. Default is the business base currency from the existing business context — no landed-cost-specific default mechanism.
- Remove the editable exchange-rate input and the client `rateTouched` override. The rate becomes a **read-only display** of what the rate book holds (`useTenantFx`, display only), rendered as `1 EUR = 157.42 KES · Source: Platform · Effective: 13 Aug 2026` using the existing FX presentation. When no rate is on file, show the honest "no rate on file" state and block submission — the server would refuse it anyway.
- Drop the client-side `baseTotal = chargeTotal * exchangeRate` arithmetic; the base total shown comes from the stamped voucher after insert.

### 3. Tests

- `src/test/architecture/landed-cost-currency.test.ts` — guards that the landed-cost module contains no currency literal list, no second FX resolver, no client accounting arithmetic, and no `COALESCE(rate, 1)`.
- pgTAP under `supabase/tests/`: arbitrary currency code rejected; base-currency voucher stamps rate 1; foreign-currency voucher stamps the rate book value; missing rate raises rather than posting at parity; tenant override wins over provider; a posted voucher rejects currency/rate mutation; allocation total reconciles to the journal (debit = credit).

### Scope boundary

This changes the landed-cost path only. Other documents already stamp through `fx_stamp_document`; nothing found here demonstrates a dependency that justifies touching them.
