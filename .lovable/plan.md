# Supplier Default Currency — Root-Cause Investigation & Remediation Plan

Prior wave (Expense & refund reversal parity) is CLOSED — archived record:
`.lovable/plan/handover-verification-verdict-reversal-wave-then-remaining-w-2026-08-12.md`.

Status: investigation complete, **no code changed**. Every claim below is backed by a
database read or file read performed in this session.

## 1. Verdict

`suppliers.default_currency` is **dead domain metadata** — unconstrained free text that no
purchasing, AP, payment, statement, GL or FX path reads. The free-text input is a *symptom*.
The real defect is that this ERP has a **base-currency-only purchasing/AP chain with an empty
FX rate book**, so foreign-currency purchasing cannot be correct today regardless of what the
supplier field says. A dropdown alone would mask this.

## 2. Confirmed facts (with evidence)

### Canonical currency model
- `public.currencies` — 146 rows (`id, code, name, symbol, decimal_places, is_active`). It is the
  canonical **catalogue**.
- The canonical **representation in transactional tables is the ISO code as `text`**, not
  `currency_id`. No transactional table in `public` carries `currency_id`; every one carries
  `currency text`. So `currency = 'USD'` is the system's contract, not a defect in itself.
- `businesses.base_currency text NOT NULL DEFAULT 'USD'`, protected by
  `enforce_business_currency_immutable` and `lock_business_currency_after_je`.
- The money model is **Model B** (base/reporting currency + legitimate foreign transaction
  currencies): `bills.currency` + `bills.currency_rate` (default 1) + `bills.company_currency_total`;
  `finance_ap_open_items` computes `base_residual_amount = residual * COALESCE(NULLIF(currency_rate,0),1)`.

### FX engine
- `public.exchange_rates` — **0 rows**. `business_active_currencies` — **0 rows**.
- One rate resolver exists: `resolve_sales_exchange_rate(org, business, currency, date)`, called by
  exactly three functions — `create_sales_order_atomic`, `convert_estimate_to_so_atomic`,
  `convert_lead_to_sales_order`. **All AR-side.** It correctly returns NULL when no rate is on file.
- There is **no AP/purchasing rate resolver at all**. `revalue_fx_balances` covers period-end only.

### The supplier field
- `suppliers.default_currency text NULL`. Constraints on `suppliers`: PK, two UNIQUEs, FKs to
  `supplier_categories` and `contacts`, and a `lifecycle_state` CHECK. **No FK to `currencies`,
  no CHECK, no default** — `'banana'` is storable (3-char UI cap is client-side only).
- UI `SupplierCreatePage.tsx:257-264` — plain `<Input maxLength={3}>` uppercasing keystrokes. Its
  initial value **is** correctly seeded from `currentBusiness.base_currency` (lines 59-66); the
  `"USD"` placeholder is cosmetic, not a hardcoded default.
- A canonical picker already exists (`useCurrencies` → `public.currencies`,
  `components/contacts/CurrencyCombobox.tsx`) but is used only by Contacts and `CreateBusinessDialog`.

### Who consumes it
| Consumer | Reads supplier currency? | Uses it economically? | Evidence |
|---|---|---|---|
| Purchase Order | No | No | `PurchaseOrderCreatePage.tsx:256` → `currency: baseCurrency` |
| Bill | No | No | `BillCreatePage.tsx:302` → `currency: baseCurrency` |
| RFQ / quotation | No | No | `rfq_quotations.currency NOT NULL`, no supplier lookup |
| Vendor credit note | No | No | `vendor_credit_notes.currency DEFAULT 'USD'`; writer takes no currency |
| Bill payment | No | No | `bill_payments.currency_rate DEFAULT 1` |
| AP aging / open items | No | No | `finance_ap_open_items` reads `bills.currency`/`currency_rate` only |
| Vendor statement | No | No | `vendorStatementView.tsx:53` → `currentBusiness.base_currency` |
| GL / journal | No | No | no posting function references `default_currency` |
| FX | No | No | no AP resolver exists |

Only writers touch it (`create_supplier`, `update_supplier_terms`, `ensure_supplier_for_contact`),
plus one reader `resolve_supplier_defaults`, whose client wrapper `resolveSupplierDefaults`
(`supplierRpcs.ts:265`) has **zero call sites**. Its only rendering use is formatting
`minimum_order_value` on the supplier record.

**"If I change KES → USD, what changes economically?" — nothing.**

### Failure modes
- Invalid code stores fine and the supplier stays purchasable: `_assert_supplier_purchasable`
  checks lifecycle/ASL only.
- Supplier ≠ bill ≠ payment currency: unpoliced, but inconsequential today because nothing reads it.
- **Missing FX is the real hazard.** With `exchange_rates` empty, a non-base bill keeps
  `currency_rate = 1`, so `company_currency_total` and `base_residual_amount` silently post 1:1.
  AR fails honestly (NULL rate); AP has no equivalent guard.
- Historical correctness is safe **only because the field is dead**. Wiring it into defaults
  without a snapshot-on-create rule would introduce retroactivity risk.

### Hardcoded-currency sweep (classified)
- `businesses.base_currency DEFAULT 'USD'` — legitimate seed.
- `DEFAULT 'USD'`: bills, purchase_orders, estimates, invoices, credit_notes, expenses,
  bank_accounts, vendor_credit_notes, supplier_item_terms, landed_cost_bills, employee_advances.
  `DEFAULT 'KES'`: purchase_returns, customer_refunds, customer_credit_balances/movements,
  ar_disputes, ar_promises_to_pay. → **Systemic architectural defect: two rival literal defaults,
  neither derived from `businesses.base_currency`.**
- `'USD'` fallbacks inside `finance_ap_open_items` / `finance_ar_open_items` — defensive, acceptable.
- UI `formatCurrency` fallbacks — cosmetic.

## 3. Classification

- **Cosmetic:** free-text input where a canonical picker already exists.
- **Domain defect:** the column has no referential integrity and no consumer — dead metadata
  posing as a procurement default.
- **Systemic defect (highest severity):** no AP-side FX resolution, empty rate book, and literal
  currency defaults on financial headers.
- **False lead:** the Vendor Credit Note currency inconsistency is **not** caused by the supplier
  field — the VCN writer never reads it. It is an independent instance of the same systemic pattern
  (literal `'USD'` default, unpopulated `exchange_rate` / `exchange_rate_date`).
- **Legacy/dead code:** `resolveSupplierDefaults` client wrapper (no callers).

## 4. Target domain contract

```text
businesses.base_currency   -> GL / reporting base (immutable after first JE)
currencies                 -> catalogue; ISO code text is the wire format
exchange_rates             -> single rate book, org-scoped, effective-dated
resolve_exchange_rate()    -> ONE resolver, AR + AP, returns NULL when absent (never invents 1)
suppliers.default_currency -> proposal-time default only; snapshotted onto the document at
                              creation, never re-read afterwards
PO / Bill / VCN / Payment  -> own currency + rate + rate_date + base amount, frozen at post time
```

## 5. Remediation, in dependency order

1. **Domain contract** — ADR: supplier currency is a *proposal default*, ISO-code text validated
   against `currencies`, snapshot-on-create, never retroactive.
2. **Database integrity** — inspect existing `suppliers.default_currency` values, normalise case,
   NULL out non-catalogue values, then add a validation trigger against `currencies(code, is_active)`.
   Same treatment for `contacts.default_currency`.
3. **FX resolver unification** — generalise `resolve_sales_exchange_rate` into one
   `resolve_exchange_rate` used by AR *and* AP, keeping NULL-on-missing semantics. Seed
   `business_active_currencies`. No new FX engine, no module-local FX logic.
4. **Header defaults** — replace literal `'USD'`/`'KES'` defaults on purchasing headers with
   base-currency derivation at write time; populate `currency_rate` / `exchange_rate_date` from the
   resolver and fail loudly when no rate exists.
5. **Purchasing writers** — PO / Bill / VCN creation resolve currency as
   `supplier.default_currency → contact.default_currency → base_currency`, then freeze the rate.
6. **UI last** — swap the supplier free-text input for `CurrencyCombobox`; show resolved currency
   and rate read-only on PO/Bill/VCN forms. No client-side FX math.
7. **Regression tests** — architecture guard banning new `currency text` columns without sibling
   rate/base-amount columns; SQL test that a non-base bill without a rate is rejected; guard that no
   purchasing header default is a currency literal.

Nothing above is implemented. On approval I execute phase by phase and update this file after each.
