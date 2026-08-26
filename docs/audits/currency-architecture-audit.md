# Currency / Multi-Currency Architecture — Forensic Audit

Date: 2026-08-26. Scope: platform, tenant, business, branch, transaction, reporting.
Evidence tags: **FACT** (verified from schema/function body/file/query), **STD** (authoritative external source), **INFER** (reasoned from FACT+STD), **UNKNOWN** (not established).

No code, schema, RLS, or data was changed in producing this report.

---

## 1. Verdict

**The currency architecture is fundamentally sound. It is not the broken model the symptom suggested.** The core invariants an enterprise accounting system must hold are present and enforced in the database, not in React:

- Base currency is immutable once journal entries exist (`trg_business_currency_lock`). **FACT**
- There is exactly one rate-resolution rule (`_pick_exchange_rate_row`), and it is `SECURITY DEFINER` server-side. **FACT**
- A missing rate refuses the posting rather than inventing 1:1 (`require_exchange_rate` raises `23514`). **FACT**
- Documents are stamped with their rate at posting, and that stamp is immutable afterwards for invoices, credit notes, and bills (`_fx_document_is_posted` guard). **FACT**
- Provider-published rates cannot be mutated (`_tg_exchange_rates_immutable_provider`). **FACT**
- Journal entry debit/credit are base-currency amounts; the trial balance never sums mixed units. **FACT**
- Realized FX is computed at settlement from each document's *stamped* rate; unrealized revaluation posts to server-resolved accounts, auto-reverses, and is blocked in closed periods (doubly — explicit check plus `enforce_fiscal_period_lock`). **FACT**
- The browser never computes an accounting amount; `resolveRateFromBook` returns `null` rather than guessing, and a suite of architecture tests enforces this. **FACT**

**The HTTP 400 you hit was the system working correctly.** It is not a bug in the accounting model. It is a bug in how the model is *presented*.

The defects are real but peripheral: four live reporting functions that silently coerce a missing rate to 1, three transaction tables whose rate column has no stamping trigger, a rate book whose non-provider rows are freely editable and deletable by any business member, a rate history only 14 days deep, and a settings page that offers a destructive action with no guard and no explanation. **The rework is corrective, not a rebuild.**

---

## 2. Domain model (in business terms)

A **company** (a `businesses` row) is the accounting entity. It keeps its books in one **base currency** — the unit every balance, report, and tie-out is ultimately expressed in. That choice is made once, at the beginning, and stops being a choice the moment the first entry is posted.

The company may **transact** in other currencies. Each such currency must first be switched on as an **operating currency**. A document raised in one of those currencies records two things permanently: the amount as the counterparty sees it, and the amount as the books see it, together with the rate that connected them on that day.

An **exchange rate** is not a setting. It is a dated observation. The platform publishes rates; a company may record an **override** for its own books; neither ever rewrites the other. When a document is posted, it takes a copy of the rate it used, and that copy is the historical truth from then on — later rate movements are new facts about the future, never corrections to the past.

Because rates move, a foreign balance that is still open drifts. Recognising that drift while the balance is open is **unrealized FX** (a revaluation, reversed next period). Recognising it when the balance is finally settled is **realized FX** (a permanent entry). They are separate events and must not be double-counted.

Everything else — the symbol, the number of decimals, where the separators go — is **presentation**. It never touches arithmetic.

---

## 3. Lifecycle

```text
company created
  └─ base currency chosen           (free)
       └─ operating currencies enabled
            └─ rates published / overridden   (dated observations)
                 └─ document raised in a foreign currency
                      └─ trigger resolves the rate for the document date
                           ├─ no rate on file  ──► REFUSED (23514)
                           └─ rate found ──► stamped onto the document
                                └─ posted to GL as base debit/credit
                                     ├─ base currency now IMMUTABLE
                                     ├─ document currency+rate now IMMUTABLE
                                     └─ open foreign balance
                                          ├─ period end ──► revaluation (unrealized, auto-reverses)
                                          └─ settlement ──► realized FX from stamped rates
                                               └─ reporting off base amounts only
```

---

## 4. Scope model

| Level | Owns | Evidence |
|---|---|---|
| **Platform** | The currency catalogue (`currencies`, 146 active) and published USD-anchored rates (`platform_exchange_rates`, readable by `anon`/`authenticated` where `is_active`). | FACT |
| **Tenant / organization** | `exchange_rates.organization_id` is the outer scope of the rate book. Org-scoped rows (`business_id IS NULL`) are supported by `_pick_exchange_rate_row`. | FACT |
| **Business** | **The accounting entity.** `businesses.base_currency` (NOT NULL, default `'USD'`). Operating currencies via `business_active_currencies`. Rates per business (all 221 live rows are business-scoped). | FACT |
| **Branch** | **Owns no currency.** `branches` has no currency column. Branches are sub-ledger dimensions of the business, not entities. | FACT |
| **Party** | `contacts.default_currency` — a *default* for new documents, normalised by `_tg_normalize_party_default_currency`. Not an accounting scope. | FACT |
| **Transaction** | Stamped `currency` + rate + derived base amount. The historical record. | FACT |
| **User** | `profiles.preferred_currency` — presentation only. | FACT |

**This is correct and matches the enterprise consensus.** QuickBooks and Business Central both bind the home currency to the company with no branch-level functional currency; Odoo binds it to `res.company` and implements branches as child companies; only NetSuite OneWorld puts a distinct base currency on subsidiaries, which is the analogue of your *business*, not your *branch*. **STD** ([BC](https://learn.microsoft.com/en-us/dynamics365/business-central/finance-currencies), [Odoo](https://www.odoo.com/documentation/17.0/applications/finance/accounting/get_started/multi_currency.html), [NetSuite](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_N269084.html))

Do **not** give branches an independent functional currency. A branch that transacts in USD inside a KES company is a foreign-currency transaction, not a second set of books.

---

## 5. Base currency lifecycle — dedicated section

### What actually happened on KES → INR

**FACT, fully traced.** `src/components/settings/CurrencySettings.tsx:168-171` issues a direct PostgREST update:

```ts
await supabase.from("businesses").update({ base_currency: baseCurrency }).eq("id", currentBusiness.id);
```

`BEFORE UPDATE OF base_currency ON businesses` fires `lock_business_currency_after_je()`, which raises:

> `Cannot change base_currency for business … — journal entries already exist. Currency is immutable after first posting.` (`ERRCODE = check_violation`)

`Joshua Holdings` has 17 journal entries and 4 invoices. **FACT.** PostgREST maps SQLSTATE `23514` to **HTTP 400**, and the UI surfaces the raw Postgres string in a destructive toast (`:175-180`).

**The database is right. The UI is wrong** — it offered an action it knew could not succeed, with no pre-flight check, no disabled state, no explanation, and no lifecycle-aware copy.

### Should it be mutable?

**No, not after posting.** All four reference systems lock it, for the same reason. **STD**

| System | Rule |
|---|---|
| QuickBooks Online | Home currency editable only while Multicurrency is off; once enabled, locked and the feature cannot be disabled ([Intuit](https://quickbooks.intuit.com/learn-support/en-global/help-article/currency/change-home-currency/L4s2W9OWw_ROW_en)) |
| Odoo | Main currency "cannot be changed once invoices have been issued" ([Odoo docs](https://www.odoo.com/documentation/17.0/applications/finance/accounting/get_started/multi_currency.html)) |
| NetSuite | Base currency changeable only "before you save any transactions" ([Oracle](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_N1397082.html)) |
| Business Central | LCY fixed at company creation; changing it mid-life is not a supported configuration change ([MS](https://learn.microsoft.com/en-us/dynamics365/business-central/finance-set-up-currencies)) |

**Why**, in accounting terms: every posted amount is a *measurement*, not a number. `debit = 129,000` means "KES 129,000, measured at the KES/USD rate on the issue date". Flipping the label to INR does not re-measure anything — it silently reinterprets every historical measurement as a different unit. Under IAS 21 / ASC 830 the functional currency is a fact about the entity's economic environment, and a genuine change is applied **prospectively** at the date of change, never by restating history.

### What a bare row update would corrupt

Nothing is recomputed, so **every** base-denominated value would be silently mislabelled: **INFER** from the schema.

| Area | Consequence |
|---|---|
| Journal entries / lines | `debit`/`credit` unchanged, now read as INR. Trial balance still "balances" — and is meaningless. |
| Stamped document rates | `invoices.exchange_rate`, `bills.currency_rate` were USD→KES. Now claim to be USD→INR. |
| AR / AP aging | `finance_ar_open_items` divides by the stamped rate to derive base — now mixes two units in one column. |
| Bank balances | `bank_accounts.currency = 'KES'` becomes a *foreign* currency account overnight, and `enforce_bank_account_currency` would demand KES be an enabled operating currency. |
| Inventory / cost layers | Carried at base cost with no currency tag — silently relabelled. |
| Fixed assets | No currency column at all (§9 D6) — cost, accumulated depreciation, and NBV silently relabelled. |
| Budgets | `currency_code` unchanged, now inconsistent with actuals. |
| Reconciliations | Cleared balances tie to a GL now in a different unit. |
| Closed periods | Filed/locked periods retroactively restated — the cardinal sin. |
| FX gain/loss | Prior realized and unrealized amounts become nonsense; `fx_revaluation_runs.base_currency` still says KES. |

### The correct lifecycle and its guards

| State | Change allowed? | Current guard |
|---|---|---|
| Created, nothing posted | Yes | Open — correct |
| Draft documents only | Yes, with a warning that draft rates re-stamp | **No guard.** Draft invoices' stamped rates would be stale — the invoice trigger only re-stamps on currency change or NULL rate, not on a base-currency change. **Gap (D11a).** |
| Foreign bank account or foreign operating currency exists | Should require explicit confirmation | **No guard** |
| First posted journal entry | **No** | `trg_business_currency_lock` — correct |
| Closed period / reconciliation / revaluation exists | **No** | Covered transitively by the JE guard |

**Recommendation:** keep `journal_entries` as the hard lock (it is the right boundary — it is the moment measurement becomes history), and add *soft* boundaries in front of it: pre-flight readiness check, explicit confirmation when drafts or foreign bank accounts exist, and re-stamp of all draft documents inside the same transaction as a permitted change.

---

## 6. Rate lifecycle

```text
platform_exchange_rates (USD-anchored, platform admin only)
        │  published per business
        ▼
exchange_rates  (organization_id, business_id?, from, to, effective_date, source, provider_key)
        │  source = 'provider' → IMMUTABLE (trigger)
        │  source = 'manual' | 'override' → freely editable  ◄── DEFECT D4
        ▼
_pick_exchange_rate_row(org, business, currency, base, on_date)
   WHERE effective_date <= on_date AND (business_id IS NULL OR = business)
   ORDER BY effective_date DESC,
            business-scoped before org-scoped,
            override(0) < manual(1) < provider(2),
            published_at DESC
   LIMIT 1
        ▼
resolve_exchange_rate → NULL if nothing on file (never 1)
require_exchange_rate → RAISE 23514 if NULL or <= 0
        ▼
fx_stamp_document → writes currency + rate onto the document
        ▼
posted → currency and rate IMMUTABLE (_fx_document_is_posted)
```

**This is a single, deterministic, correct authority.** `describe_exchange_rate` exposes the same pick with provenance (`source`, `provider_key`, `scope`) and an authorisation check. The client mirror in `src/services/fx/rateBook.ts` reproduces the same precedence for display and refuses to invent a rate. **FACT**

Guards present: `CHECK (rate > 0)` blocks zero and negative rates; `exchange_rates_source_check` constrains source to the three known values; `_tg_exchange_rates_normalize` rejects an identity pair with rate ≠ 1 and validates both codes against the catalogue; `exchange_rates_scope_unique` prevents duplicate rows per scope/pair/date/source. **FACT — the (f) edge cases from the brief are already handled.**

---

## 7. Business-event map

| Event | Currency stored | Rate stored | Stamped by | Consumers |
|---|---|---|---|---|
| Estimate raised | `currency` | `exchange_rate` | `_tg_stamp_estimate_currency` | Sales pipeline |
| Sales order confirmed | `currency` | `exchange_rate` | `_tg_stamp_sales_order_currency` | Fulfilment, invoicing |
| **Invoice posted** | `currency` | `exchange_rate` (immutable) | `_tg_stamp_invoice_currency` | AR, GL, aging, FX exposure, revenue reports |
| Credit note posted | `currency` | `exchange_rate` (immutable) | `_tg_stamp_credit_note_currency` | AR, GL, realized FX |
| Customer payment / refund | refund: `currency`+rate; payment: **neither** | — | `_tg_stamp_customer_refund_currency` | AR settlement, realized FX via `apply_credit_to_invoice_atomic` |
| Purchase order | `currency` | `exchange_rate` | `_tg_stamp_po_currency` | Commitments, 3-way match |
| **Bill posted** | `currency` | `currency_rate` + `company_currency_total` (immutable) | `_tg_stamp_bill_currency` | AP, GL, aging |
| Vendor credit note | `currency` | `exchange_rate` | `_tg_stamp_vcn_currency` | AP, realized FX |
| Vendor payment | **no currency col** | `currency_rate` | **none** ◄ D3 | AP settlement |
| Expense | `currency` | `exchange_rate` → `base_amount` | `_expenses_derive_base_amount` | GL |
| Landed cost voucher | `currency` | `exchange_rate` | `_landed_cost_component_sync` (hard-fails on null/zero) | Inventory cost |
| Bank transaction | — | `exchange_rate` | **none** ◄ D2 | Reconciliation, GL |
| Journal entry / line | `currency` / `original_currency` | `exchange_rate` | source-document driven | Trial balance, GL, all reports |
| Settlement / allocation | — | uses both documents' **stamped** rates | `apply_credit_to_invoice_atomic`, `refund_*_atomic` | **Realized FX** → `resolve_fx_realized_account` |
| Period-end revaluation | run-level `base_currency` | per-line old/new rate | `revalue_fx_balances` | **Unrealized FX**, auto-reversing |

---

## 8. Confirmed defects

### D1 — Four live reporting functions silently value a foreign document at 1:1 · **HIGH** · FACT

`finance_sales_analysis`, `finance_purchase_analysis`, `finance_sales_revenue_reconciliation`, `finance_purchase_expense_reconciliation` all contain `COALESCE(NULLIF(exchange_rate, 0), 1)` over `invoices`, `credit_notes`, and `vendor_credit_notes`. Verified live in `pg_proc`, not just migration history.

**Consequence:** a foreign document with a null or zero stamped rate is reported at face value — USD 1,000 counted as KES 1,000. Worse, two of the four are the *sub-ledger-to-GL reconciliation* functions, so the report that exists to detect drift is the one that hides it: it would tie out against a GL that has the correct base amount only by understating the document side. This is the exact silent-1:1 pattern the rest of the codebase was deliberately purged of (`finance_ar_open_items` and the landed-cost path were both fixed on 2026-08-21) — these four were missed.

### D2 — `bank_transactions.exchange_rate` has no stamping or validation trigger · **HIGH** · FACT

`bank_transactions` carries 7 triggers (scope, business match, closed-window, payroll match, org lock, timestamps) and **none of them touches currency or rate**. The column is written by whatever inserts the row — statement import, manual entry, matching. It is never resolved through `fx_stamp_document`, never validated against the rate book, and never frozen after reconciliation.

**Consequence:** a foreign bank line can be posted at an arbitrary, unsourced, or absent rate; a rate can be silently altered after the line is reconciled and posted. Banking is where FX most often becomes real, and it is the one high-volume module outside the stamper.

### D3 — `bill_payments.currency_rate` has no stamping trigger and no currency column · **HIGH** · FACT

`bill_payments` carries a NOT NULL `currency_rate` but no `currency`, and none of its 6 triggers resolves or validates that rate. Vendor payment is precisely where **realized FX on the AP side** is determined.

**Consequence:** the settlement rate on a supplier payment is client-supplied and unvalidated, and the currency it applies to is inferred rather than recorded. Contrast the AR side, where `apply_credit_to_invoice_atomic` computes realized FX from immutable stamped rates.

### D4 — Non-provider rate rows are freely editable and deletable, by any business member · **HIGH** · FACT

Three compounding facts:
1. `_tg_exchange_rates_immutable_provider` protects `source = 'provider'` only. Rows with `source IN ('manual','override')` have no immutability guard on UPDATE or DELETE.
2. RLS policy `exchange_rates_all` grants `ALL` on the condition `user_can_access_business(auth.uid(), business_id)` — **no finance-role check**. Any user with access to the company can insert, edit, or delete override rates. Compare `business_active_currencies`, which correctly requires owner/admin, and `fx_revaluation_runs`, which requires `is_finance_manager`.
3. `CurrencySettings.tsx:250-256` exposes a delete button wired to a direct table `DELETE`, behind a `window.confirm`.

**Consequence:** the rate book is not an audit record. A user can insert an override, post documents against it, then delete the override — leaving posted entries whose rate has no traceable source. Posted documents keep their stamp, so history is not restated, but the *evidence* for it is destroyed. No enterprise system permits this.

### D5 — Backdated overrides silently change historical rate resolution · **MEDIUM-HIGH** · FACT

`_pick_exchange_rate_row` selects `effective_date <= on_date` ordered by `effective_date DESC` then source rank. Inserting an override dated in the past outranks the provider row for that date. Posted documents are shielded by their stamp, but any *subsequent* operation that re-resolves a historical date — a new revaluation run, a backdated document, a report calling `describe_exchange_rate` — sees the new answer. There is no closed-period guard on writes to `exchange_rates`.

**Consequence:** rate history for a closed period can be rewritten after the fact.

### D6 — Fixed assets have no currency infrastructure at all · **MEDIUM** · FACT

`fixed_assets` has no `currency` and no rate column. Acquisition cost, depreciation, carrying value, and disposal gain/loss are bare numbers implicitly in base currency.

**Consequence:** a machine bought in USD cannot record what it actually cost in USD or the rate at acquisition. Under IAS 21 a non-monetary asset is carried at the historical rate — that rate is not recorded anywhere and cannot be reconstructed. Note `fx_is_monetary_account` exists and correctly excludes non-monetary accounts from revaluation, so the *revaluation* side is right; the *acquisition evidence* is missing.

### D7 — Budgets carry a currency code but no rate · **MEDIUM** · FACT

`budgets.currency_code` with no `exchange_rate`. Budget-vs-actual across currencies has no defined conversion. The brief asked whether budgets are base-only, currency-aware, or incorrectly mixed: **they are incorrectly mixed** — a currency label with no conversion mechanism behind it.

### D8 — The rate book is 14 days deep · **MEDIUM** · FACT

All 221 rows span `2026-08-12` to `2026-08-26`, all `source = 'provider'`, zero overrides, zero manual rates. Because `_pick_exchange_rate_row` requires `effective_date <= on_date`, **any foreign-currency document dated before 2026-08-12 cannot be posted at all** — `require_exchange_rate` will raise. Correct refusal, unusable operationally: opening balances, backdated bills, and historical migration are all blocked with a message that reads like a bug.

### D9 — Stamp-immutability guard is missing on four document types · **MEDIUM** · FACT

`_tg_stamp_invoice_currency`, `_tg_stamp_bill_currency`, and `_tg_stamp_credit_note_currency` check `_fx_document_is_posted` before allowing a currency/rate change. `_tg_stamp_estimate_currency`, `_tg_stamp_sales_order_currency`, `_tg_stamp_customer_refund_currency`, and `_tg_stamp_po_currency` do not. Customer refunds and POs in particular can reach a posted/committed state.

### D10 — `rfq_quotations.exchange_rate` has zero triggers · **MEDIUM** · FACT

The table has no triggers at all. Supplier quotation rates are entirely client-supplied and unvalidated, and they feed award decisions and PO creation.

### D11 — Re-stamp asymmetry between invoices and bills · **LOW-MEDIUM** · FACT

`_tg_stamp_bill_currency` re-stamps whenever `bill_date` changes. `_tg_stamp_invoice_currency` re-stamps only on currency change or NULL rate — **not** when `issue_date` changes. A draft invoice moved to a different date keeps the old date's rate. Two different rules for the same concept.

### D12 — Two divergent formatting policies; zero-decimal currencies wrong in reports · **LOW** · FACT

`CurrencyContext.formatCurrency` correctly reads `currencies.decimal_places`. `src/design-system/reports/format.ts` hardcodes `minimumFractionDigits: 2, maximumFractionDigits: 2` and hardcodes a ~40-entry `CURRENCY_SYMBOLS` map. JPY, UGX, and TZS are all seeded `decimal_places = 0` — they render correctly on screen and with two spurious decimals in reports and PDFs. `currencyPresentation.ts:formatDocumentAmount` has the same hardcoded 2dp.

INR lakh/crore grouping is **absent**, not leaked into math — no `en-IN` or lakh/crore logic exists anywhere. That is the safe failure mode; it is a presentation gap only.

### D13 — Duplicated, unattached base-currency policy · **LOW** · FACT

`enforce_business_currency_immutable()` implements the same rule as `lock_business_currency_after_je()` but is attached to no trigger. It also contains a teardown escape hatch (`_is_teardown_for_org`) the live guard lacks. Two copies of a critical policy, one dead — a future editor may fix the wrong one.

### D14 — Column vocabulary drift · **LOW** · FACT

Four names for one concept (`currency`, `original_currency`, `currency_code`, `default_currency`) and two for another (`exchange_rate`, `currency_rate`). Every consumer must know which dialect each table speaks. This is how D1's four functions got missed by a grep for `exchange_rate`.

### D15 — Concurrent revaluation race · **LOW** · INFER

`revalue_fx_balances` guards one posted run per fiscal period with a check-then-insert `EXISTS`, with no `FOR UPDATE`, advisory lock, or unique index. Two concurrent runs for the same period could both pass. No partial unique index on `(business_id, fiscal_period_id) WHERE status = 'posted'` exists. Low likelihood, high blast radius.

---

## 9. Missing capabilities

**Genuinely missing:**
- Rate history beyond 14 days, and any backfill path for historical or opening-balance dates (D8).
- Currency and acquisition-rate evidence on fixed assets (D6).
- A defined budget-vs-actual conversion rule (D7).
- Server-side stamping for bank transactions, vendor payments, and RFQ quotations (D2, D3, D10).
- An immutable audit trail on the rate book (D4). `set_exchange_rate_override` records a reason on insert; nothing records edits or deletions.
- A base-currency readiness/pre-flight check surface.

**Not missing, and should not be built:**
- Branch-level functional currency — architecturally wrong (§4).
- A "convert my books to a new base currency" migration. All four reference systems refuse this. **STD**
- Separate spot/average/historical rate *types*. Only NetSuite has them, and only for consolidated multi-subsidiary reporting; you have one accounting entity per set of books, so the single dated rate matches QuickBooks, Odoo, and BC. **STD**
- Client-side conversion of any kind. Already correctly prohibited and test-enforced.

---

## 10. Dangerous capabilities currently allowed

1. **Deleting an override rate that posted documents were valued with** (D4) — destroys audit evidence.
2. **Editing a `manual`/`override` rate in place** (D4) — no immutability, no history.
3. **Backdating an override into a closed period** (D5).
4. **Writing an unvalidated rate onto a bank transaction or vendor payment** (D2, D3).
5. **Offering "change base currency" as an ordinary Save button** (§16) — an irreversible accounting event presented as a settings mutation. It happens to be blocked *after* posting; before posting it is one unguarded click that silently changes the meaning of every draft.

---

## 11. Security / isolation defects

**Isolation is intact.** `user_can_access_business` gates every currency table, `SECURITY DEFINER` FX functions validate ownership (`describe_exchange_rate`, `set_exchange_rate_override`, `set_business_active_currency` all raise `42501`), `_pick_exchange_rate_row` filters on `organization_id` and `(business_id IS NULL OR = p_business_id)`, and `revalue_fx_balances` verifies the gain/loss accounts belong to the business. **No cross-tenant or cross-business leak was found.** **FACT**

Two issues:

- **S1 · MEDIUM — privilege gap on the rate book.** `exchange_rates_all` grants `ALL` to anyone with business access, with no finance-role predicate. This is the RLS half of D4. Every sibling table gets this right: `business_active_currencies` requires owner/admin, `fx_revaluation_runs` requires `is_finance_manager`, `platform_exchange_rates` requires `is_platform_admin`.
- **S2 · LOW (latent) — org-scoped rates are invisible to the client.** `user_can_access_business(uid, NULL)` returns false for non-platform-admins, so a row with `business_id IS NULL` is filtered out by RLS. The server resolver is `SECURITY DEFINER` and still sees it. Today all 221 rows are business-scoped so nothing breaks; the moment an org-level rate is published, the server will post at a rate the UI insists does not exist. Latent, but it will present as an inexplicable bug.

---

## 12. Accounting correctness defects

Sound: rate resolution, refusal on missing rate, zero/negative rate constraints, identity-pair validation, stamping, posted immutability (where present), base-only trial balance, realized FX from stamped rates, auto-reversing unrealized revaluation, hard-fail on unmapped FX accounts, monetary-account filtering, closed-period enforcement (doubly).

Defective: **D1** (silent 1:1 in four live reports, including the reconciliations), **D2/D3/D10** (unstamped rates on bank, vendor payment, RFQ), **D5** (backdated override rewrites historical resolution), **D6** (no historical rate for non-monetary assets), **D8** (no rate history to post against).

One deliberate design point worth stating: an interim unrealized revaluation is never "consumed" at settlement — realized FX is computed independently from the original documents' stamped rates, and the unrealized entry is simply reversed. **This is correct** and matches Odoo's reversing revaluation and BC's Adjust Exchange Rates. **STD/INFER** — no double count.

---

## 13. Lifecycle defects

- No soft guards before the hard base-currency lock; no draft re-stamp on a permitted change (§5).
- Four document types lack the posted-immutability guard (D9).
- Invoice/bill re-stamp asymmetry (D11).
- Rate book rows have no lifecycle at all — no supersede, no soft-delete, no audit (D4).
- No closed-period guard on rate writes (D5).
- Disabling an operating currency: `_bac_protect_base_currency` and `set_business_active_currency` correctly prevent disabling the base currency, and `enforce_bank_account_currency` requires an enabled currency for foreign bank accounts. But **nothing checks for existing open documents when disabling a non-base currency** — existing postings are unaffected (correct), yet an open foreign AR balance can be stranded in a disabled currency. All four reference systems allow deactivate-but-never-delete for used currencies; matching them means blocking the disable while open balances exist. **STD**

---

## 14. Architecture defects

- **One rate engine, and it holds.** No competing rate resolution was found in TypeScript or SQL. The client mirror is documented, display-only, and refuses to invent. Architecture tests (`fx-single-engine`, `no-silent-currency-fallback`, `fx-tenant-isolation`, `currency-integrity`, `banking-currency-integrity`, `fx-rate-panel-single-surface`) actively enforce this. **This is the strongest part of the system.** **FACT**
- **No client-side accounting math.** No `amount * rate` was found feeding an insert/update payload for any accounting table. The `* rate` sites are `rateBook`, `platformUsd`, `useAdminCurrency`, and `usePricingCurrency` — all display/pricing, all null-safe. **FACT**
- **Three tables sit outside the engine** (D2, D3, D10) — not a competing engine, an *absent* one.
- **Two formatting policies** (D12).
- **A dead duplicate of a critical policy** (D13).
- **Vocabulary drift across four/two names** (D14) — the direct cause of D1 escaping the cleanup.

---

## 15. UI / UX defects

All in `src/components/settings/CurrencySettings.tsx`. **FACT**

| # | Issue | Evidence |
|---|---|---|
| U1 | Base currency offered as a plain Select + Save with no pre-flight check, no disabled state when journal entries exist, and no warning. The card *says* it is locked after the first entry but does not enforce or check it. | `:298-316`, `:290-292` |
| U2 | The failure surfaces as a raw Postgres string in a red toast — `"Cannot change base_currency for business bf392ca6-… — journal entries already exist"`, complete with UUID. | `:175-180` |
| U3 | Operating currencies render **all 146 active currencies** as flat switches with no search, no filter, and no enabled-only view. Two are on; 144 are noise. | `:332-348` |
| U4 | The Rate Book renders **all 221 rows** unpaginated, unfiltered, unsearchable, with no pair grouping. | `:392-428` |
| U5 | No indication of which rate is *currently in effect* for a pair — the whole point of a dated rate book. `describe_exchange_rate` already returns exactly this (rate, source, provider_key, effective_date, scope) and is unused here. | — |
| U6 | Delete button on override/manual rates behind a bare `window.confirm`, wired to a direct table DELETE. | `:241-258`, `:414-426` |
| U7 | No rate-history view per pair, no override-vs-provider comparison, no audit column (who/when/why) despite `set_exchange_rate_override` capturing a mandatory reason. | `:212-219` |
| U8 | Four distinct concepts — base currency, operating currencies, rate book, overrides — collapsed onto one scrolling page with no hierarchy of consequence. | whole file |
| U9 | Base currency select lists all 146 currencies including ones with no rate coverage at all. | `:303-307` |

The correct UX: base currency as a **status** with a lifecycle badge ("Locked — 17 journal entries posted") and an explanatory panel, not an editable control; operating currencies as an enabled-list with an "Add currency" search dialog; the rate book filtered to *enabled pairs only*, grouped by pair, showing the currently-effective rate with provenance, with history behind a per-pair drill-down.

---

## 16. Enterprise comparison

| Concept | This system | QuickBooks Online | Odoo | NetSuite | Business Central | Verdict |
|---|---|---|---|---|---|---|
| Currency-owning entity | Business | Company | `res.company` | Subsidiary | Company | **Correct** |
| Branch functional currency | None | None | None | Subsidiary-level | None | **Correct** |
| Base currency mutability | Locked after first JE | Locked once multicurrency on | Locked once invoices issued | Locked once any transaction saved | Fixed at creation | **Correct; arguably the most precise boundary of the five** |
| Rate storage | Dated rows, provider/manual/override | Rate history + per-txn override | `res.currency.rate` per date | Currency Exchange Rates + Consolidated (current/avg/historical) | Exchange Rate table by starting date + separate adjustment rate | **Correct for a single-entity book** |
| Rate precedence | Latest date, business>org, override>manual>provider | Auto rate, manual override wins | Latest date ≤ txn date | Nearest date ≤ txn date | Latest starting date ≤ posting date | **Correct and more explicit than most** |
| Posted rate immutable | Yes (invoice/CN/bill); no for bank/vendor payment | Yes | Yes | Yes | Yes | **Gap — D2/D3** |
| Missing rate | Hard refusal | Blocks save | Falls back to nearest prior | Blocks save | Falls back to nearest prior | **Correct (strictest); needs D8 backfill to be usable** |
| Zero/negative rate | `CHECK (rate > 0)` | Invalid | Invalid | Invalid | Invalid | **Correct, and explicitly constrained** |
| Realized FX | At settlement from stamped rates | At payment | At reconciliation | At application | At application | **Correct** |
| Unrealized FX | Revaluation run, auto-reverses next period | Manual home-currency adjustment | Reverses first day of next period | Period-end revaluation | Adjust Exchange Rates batch | **Correct — matches Odoo, ahead of QuickBooks** |
| Unmapped FX account | Hard raise | Auto system account | Configured accounts | Configured | Per-currency card | **Correct (fails loudly)** |
| Closed periods | Doubly enforced | Enforced | Enforced | Enforced | Enforced | **Correct** |
| Disable used currency | Allowed (open balances not checked) | Cannot delete, inactivate only | Cannot delete, deactivate only | Cannot delete, inactivate only | Cannot delete, block only | **Gap — D13/§13** |
| Rate row immutability | Provider only | Not user-deletable | Editable by accountant | Auditable | Auditable | **Gap — D4, weakest point vs peers** |

**Where the vendors differ, and what it means for you:** NetSuite is the only one with rate *types* and consolidated rates, because it is the only one with a subsidiary hierarchy of differing functional currencies. You have one functional currency per set of books, so the QuickBooks/Odoo/BC single-dated-rate model is the right one and you already implement it. Do not import NetSuite's complexity.

---

## 17. Rework contract

Dependency-ordered. Each phase is independently shippable and independently verifiable.

### Phase 1 — Stop the bleeding: silent 1:1 in reports (D1)
- **What:** Replace `COALESCE(NULLIF(exchange_rate, 0), 1)` with NULL-propagation in `finance_sales_analysis`, `finance_purchase_analysis`, `finance_sales_revenue_reconciliation`, `finance_purchase_expense_reconciliation`. Surface unconvertible documents as an explicit count, as `finance_ar_net_position_by_currency.unconvertible_document_count` already does.
- **Why:** the reconciliation reports currently conceal the exact drift they exist to detect.
- **Depends on:** nothing. **Must not change:** any posted amount, any stamped rate, any GL balance.
- **Validation:** run all four before/after on Joshua Holdings; totals must be identical where every document has a rate, and must report an absence rather than a number where one does not.
- **Invariant:** no report may value a foreign document at 1:1 unless the currencies are identical.

### Phase 2 — Rate-book integrity and privilege (D4, S1, D5)
- **What:** Extend the immutability trigger to all sources — no UPDATE, no DELETE on any `exchange_rates` row; corrections become a new row with a later `published_at`, exactly as provider rows already work. Add an `exchange_rate_audit` trail (actor, reason, prior value). Narrow `exchange_rates_all` to a finance-manager predicate, keeping `exchange_rates_select` broad. Reject override writes whose `effective_date` falls in a closed fiscal period. Remove the client delete path; overrides are superseded, never deleted.
- **Why:** the rate book must be an audit record before anything else depends on it.
- **Depends on:** Phase 1 (so reports do not mask the change).
- **Must not change:** the precedence rule, provider publishing, any stamped rate.
- **Validation:** attempt UPDATE and DELETE on an override as owner — both must fail; attempt an override insert into a closed period — must fail; posted document rates unchanged.
- **Invariants:** a rate consumed by a posting is permanently recoverable; only a finance manager writes rates; the closed-period boundary applies to rate evidence as it does to entries.

### Phase 3 — Close the stamping gaps (D2, D3, D10, D9, D11)
- **What:** Add `_tg_stamp_*_currency` triggers routing through `fx_stamp_document` for `bank_transactions`, `bill_payments` (adding an explicit `currency` column), and `rfq_quotations`. Add the `_fx_document_is_posted` immutability guard to estimates, sales orders, customer refunds, and POs. Align the invoice re-stamp rule with the bill rule (re-stamp on document-date change while unposted).
- **Why:** three high-value tables carry a rate that no server authority ever validated.
- **Depends on:** Phase 2 (an unstamped rate must resolve against an immutable book).
- **Must not change:** existing stamped values — backfill validates and reports mismatches rather than rewriting; anything genuinely wrong is corrected by an explicit, audited entry.
- **Validation:** insert a foreign bank transaction with a bogus rate — must be overwritten by the resolved rate or refused; alter the rate on a reconciled line — must fail.
- **Invariant:** every rate that reaches the GL was resolved server-side by the one engine.

### Phase 4 — Rate coverage and history (D8)
- **What:** Backfill provider history to cover the earliest transaction date in each business; define a retention and publishing schedule; expose a coverage indicator ("rates on file from …"). Decide and document the policy for a date before coverage begins — refuse, or require an explicit dated override with a reason (recommended: the latter, since it keeps the evidence).
- **Why:** a correct refusal that blocks all historical entry is operationally indistinguishable from a bug.
- **Depends on:** Phase 2.
- **Validation:** post a backdated foreign bill at the earliest business transaction date; it must succeed or refuse with a message that names the missing coverage and the remedy.
- **Invariant:** the system never invents a rate to make a date work.

### Phase 5 — Base-currency lifecycle surface (§5, D13, U1, U2)
- **What:** A `business_currency_readiness(business_id)` function returning the lifecycle state and every blocker (journal entries, drafts, foreign bank accounts, enabled currencies, reconciliations, closed periods). Convert the change path from a direct table update into an audited RPC that re-stamps drafts in the same transaction when the change is permitted. Delete the dead `enforce_business_currency_immutable`.
- **Why:** the hard lock is right; everything in front of it is missing.
- **Depends on:** Phase 3 (drafts must be re-stampable through the one engine).
- **Must not change:** the immutability rule itself — the JE boundary stays.
- **Validation:** the readiness function must report Joshua Holdings locked with a JE count of 17, and Dekto Logistics open; the RPC must refuse the former and succeed on the latter with drafts re-stamped.
- **Invariants:** base currency is never mutated outside the audited RPC; posted history is never restated.

### Phase 6 — Non-monetary and budget currency (D6, D7)
- **What:** Add `currency` + acquisition `exchange_rate` (+ derived base cost) to `fixed_assets`, stamped at acquisition and immutable thereafter, so IAS 21 historical-rate carrying is reconstructable. Decide the budget rule — recommended: budgets are base-currency only, and `budgets.currency_code` is either constrained to the base currency or given an explicit dated conversion.
- **Why:** the last two places where a currency label exists without a measurement behind it.
- **Depends on:** Phase 3.
- **Validation:** acquire a USD asset in a KES business; cost, depreciation, and NBV must reconcile to the GL at the acquisition rate, unaffected by later rate moves.
- **Invariant:** non-monetary assets are never revalued by FX (already enforced by `fx_is_monetary_account`).

### Phase 7 — Presentation convergence (D12, D14)
- **What:** One formatter reading `currencies.decimal_places` and `currencies.symbol` from the catalogue; delete the hardcoded 2dp and the hardcoded symbol map from `src/design-system/reports/format.ts` and `currencyPresentation.ts`. Optionally add `en-IN` grouping for INR — presentation only. Document the column vocabulary and, where cheap, converge it.
- **Why:** JPY, UGX, and TZS currently print two decimals that do not exist.
- **Depends on:** nothing; sequenced late because it is cosmetic.
- **Must not change:** any stored or computed amount.
- **Validation:** render JPY, UGX, TZS, INR, KES on screen and in a PDF — screen and PDF must agree, and zero-decimal currencies must show zero decimals.
- **Invariant:** formatting never participates in arithmetic.

### Phase 8 — Currency Settings UX (U3–U9)
- **What:** Rebuild the page as three surfaces: base currency as a lifecycle status card driven by the Phase 5 readiness function; operating currencies as an enabled-list plus searchable add-dialog; rate book filtered to enabled pairs, showing the currently-effective rate with provenance from `describe_exchange_rate`, with per-pair history and audit behind a drill-down.
- **Depends on:** Phases 2, 4, 5.
- **Validation:** no unfiltered list of 146 or 221 rows anywhere; every destructive action states its consequence before it is taken.

### Phase 9 — Regression protection (D15, S2, §13)
- **What:** Extend the architecture test suite to assert: no `COALESCE(<rate>, 1)` in any `pg_proc` body or view; every table with a rate column has a stamping trigger; every currency table's write policy carries a role predicate. Add the partial unique index on `(business_id, fiscal_period_id) WHERE status = 'posted'` plus an advisory lock in `revalue_fx_balances`. Resolve S2 by either supporting org-scoped rates in the client read or dropping the org scope from the resolver. Block disabling an operating currency that has open balances.
- **Depends on:** all prior phases.
- **Invariant:** every defect in this report has a test that fails if it returns.

---

## Open UNKNOWNs

- Inventory cost layers, payroll, and POS were not confirmed to carry currency columns; they appear base-only. **Requires a dedicated schema pass.**
- Whether any of the ~205 `toFixed(2)` sites in `src` render a zero-decimal currency amount. **Requires a triage pass.**
- The materiality of D6 depends on the fixed-asset acquisition RPCs, which were not read.
- Whether `payments` / `payment_allocations` permit cross-currency allocation (payment carries neither currency nor rate). **Requires reading the allocation write path.**
