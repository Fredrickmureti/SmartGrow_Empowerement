# Currency & FX — architecture audit findings and convergence plan

## What the investigation established (evidence-backed)

The ERP does **not** have one monetary/FX architecture. It has **three disconnected
rate systems** plus a set of monetary domains that never touch any of them.

### 1. Two rate books that never meet

| Store | Rows today | Shape | Who writes | Who reads |
|---|---|---|---|---|
| `platform_exchange_rates` | 14 | USD-anchored, **no effective date, no provenance, no org** | provider edge functions (`provider-run`), platform admin UI | pricing page, admin display toggle, `useTenantFx` (Banking totals) |
| `exchange_rates` (accounting) | **0** | org/business scoped, effective-dated | only manual tenant UI (`CurrencySettings`, `CurrencyContext`) | `resolve_exchange_rate` / `require_exchange_rate` — the accounting resolver |

The provider pipeline (exchangerate.host / OXR / Fixer / FreeCurrencyAPI, test, activate,
30-minute pg_cron → `provider-run`) is genuinely built — but it writes **only** to the
display table. **No code path bridges provider rates into the accounting rate book.** The
accounting rate book is empty, so every foreign-currency purchasing document currently
fails, by design, with "no exchange rate on file".

### 2. A third, client-side FX engine

`CurrencyContext.getExchangeRate` returns **1 when no rate is found** (silent 1:1), and
`useAdminCurrency.usdToTargetRate` does the same. `useTenantFx` is honest (returns null).
Three conversion implementations, three different missing-rate policies.

### 3. Monetary domains are inconsistent at the column level

Verified against live schema:

- `bills` → `currency_rate` + `company_currency_total`; `invoices` → `exchange_rate`;
  `expenses` → `exchange_rate` + `base_amount`; `vendor_credit_notes` → rate + rate date.
- **No rate column at all**: `purchase_orders`, `estimates`, `credit_notes`,
  `customer_refunds`, `bill_payments` (has `currency_rate` but no currency), `payslips`.
- Rate stamping triggers exist for **only four tables** (bills, PO, VCN, purchase returns).
- `expenses` hardcodes rate `1` when none supplied; sales orders can persist a **NULL**
  rate for a foreign-currency document.
- **~30 tables still carry literal `DEFAULT 'USD'` / `DEFAULT 'KES'`** — including
  `invoices`, `estimates`, `credit_notes`, `sales_orders`, `expenses`, `bank_accounts`,
  `customer_refunds`, `proforma_invoices`, `project_cost_entries`. Only the four
  purchasing tables were cleaned up previously.

### 4. Settlement and revaluation

- **No realized FX gain/loss is posted anywhere.** `record_multi_invoice_payment` accepts a
  rate but posts only Dr Bank / Cr AR. `record_multi_bill_payment` has **no rate parameter
  at all** — a foreign bill paid from a base-currency bank posts at face value.
- `revalue_fx_balances` exists and posts unrealized FX, but is manual-screen-only.

### 5. Security / tenancy

- Provider API keys sit in `platform_integration_connections.credentials` as **plaintext
  jsonb, selected into the browser** by the admin console (RLS limits this to platform
  admins, but the keys still reach client JS).
- `platform_exchange_rates` is readable by `anon` — acceptable for pricing, wrong as an
  accounting source.
- There is **no tenant override model** over platform rates; the two tables are simply
  unrelated.

Ranked risk: **critical** — no realized FX at settlement, AP settlement FX-blind, expenses
silently valued at 1:1. **High** — provider rates never reach accounting; literal currency
defaults on AR/expense/bank tables; NULL rate on sales documents; plaintext keys in browser.
**Medium** — three conversion engines; revaluation unscheduled. **Low** — display polish.

## Target architecture

```text
Provider (edge fn, server-only creds)
        v
platform_exchange_rates        <- market/reference data, undated display + source feed
        v  publish_platform_rates_to_org()  (effective-dated, provenance stamped)
exchange_rates                 <- ONE accounting rate book: org/business, effective date,
        |                          source ('provider'|'manual'|'override'), audit trail
        v
resolve_exchange_rate / require_exchange_rate   <- ONE resolver (already exists)
        v
document triggers stamp currency + rate + base amount at creation  (immutable once posted)
        v
GL posting (post_journal_entry_atomic)  ->  settlement (+ realized FX)  ->  revaluation
```

Rules the rebuild enforces: provider data is market data and only becomes an accounting rate
when published with an effective date and provenance; tenant override wins over published
platform rate and never mutates it; missing required rate raises, never returns 1; the
browser may display a rate, never compute an accounting one.

## Implementation, in dependency order

1. **Rate-book contract.** Extend `exchange_rates` with `source`, `provider_key`,
   `published_at`, `created_by`, uniqueness on (org, business, from, to, effective_date);
   keep it effective-dated and append-only. Add provenance audit.
2. **Bridge provider → accounting.** A server-side publisher (`publish_platform_rates`)
   invoked by the same cron that runs `provider-run`, writing effective-dated rows into
   `exchange_rates` for every org whose base currency needs a pair, stamped
   `source='provider'`. Platform rows are never read by accounting again.
3. **Tenant override.** Manual rows written by the tenant carry `source='override'` and win
   in `resolve_exchange_rate` precedence: override → provider-published → none (raise).
4. **Kill the parallel engines.** Delete `CurrencyContext.getExchangeRate` /
   `convertCurrency` and the silent-1 path in `useAdminCurrency`; the single display path
   becomes `useTenantFx`, retargeted at the accounting rate book with an honest null state.
   Dashboard's one conversion call site moves to it.
5. **Complete the snapshot columns.** Add `exchange_rate` (+ base amount where the domain
   needs it) to `estimates`, `purchase_orders`, `credit_notes`, `customer_refunds`, and
   normalise the bills/`currency_rate` vs invoices/`exchange_rate` naming onto one contract.
6. **Stamping triggers for every monetary document**, all calling `require_exchange_rate`:
   invoices, estimates, sales orders, credit notes, customer refunds, expenses,
   bank transactions. Remove the `COALESCE(rate, 1)` fallbacks in the bill/purchase-return/
   expense triggers and in `post_expense_gl`.
7. **Literal defaults.** Drop `DEFAULT 'USD'`/`'KES'` from every transactional table listed
   above; keep it only on `businesses.base_currency` (install default) and on
   platform/pricing tables where USD is the actual denomination.
8. **Realized FX at settlement.** Add rate awareness to `record_multi_bill_payment`, and an
   FX gain/loss leg to both AR and AP settlement when the settlement rate differs from the
   document rate, using new default-account roles (`fx_realized_gain` / `fx_realized_loss`)
   resolved through the existing default-accounts mechanism. Posting stays inside
   `post_journal_entry_atomic` (ADR 0123).
9. **Revaluation integration.** Keep `revalue_fx_balances`, feed it from the canonical
   resolver at period-end rate, and make its run scope/idempotency explicit.
10. **Credential hardening.** Stop selecting `credentials` into the browser; expose a masked
    projection and move save/test through a server function.
11. **UI.** One tenant FX screen: base currency, current rates with source badge
    (Platform / Manual override) and effective date, override action, and an explicit
    "no rate on file" state on any foreign-currency document.
12. **Delete obsolete pieces**: `resolve_sales_exchange_rate` shim, the client conversion
    helpers, `src/lib/migration/currencyValidation.ts` conversion if the import path is
    confirmed not to persist it.
13. **Ratchets.** Extend `src/test/architecture/currency-integrity.test.ts` to forbid: new
    rate tables, client-side rate arithmetic, `COALESCE(rate,1)`, literal currency defaults
    on transactional tables, and any resolver other than the canonical pair. Add
    business-event tests: platform rate → publish → PO → bill → GL → payment at a different
    rate → realized FX → revaluation, then the same with a tenant override, proving the
    override is tenant-scoped and history is immutable.

## Deliverables

ADR 0136 (canonical monetary architecture, superseding the rate-book parts of ADR 0135),
updated `mem://features/currency-and-fx-resolution`, and the architecture ratchet suite.

## Notes on what was NOT verified

Live `cron.job` state for the 30-minute provider refresh; whether the CSV-import path
persists client-converted amounts; whether `apply_vendor_credit_*` resolves rates. Each is
checked first in the step that touches it, before code changes there.
