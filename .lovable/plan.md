# Currency / Multi-Currency — Forensic Audit Contract

No code, schema, RLS, or data will be changed in this wave. The deliverable is a written audit report plus a dependency-ordered rework contract.

## What the pre-audit reads already established (FACT)

These come from direct database and codebase inspection in this session, and they change the shape of the audit:

- **Base currency is already immutable after posting.** `public.businesses.base_currency` is guarded by trigger `trg_business_currency_lock` → `lock_business_currency_after_je()`, which raises a check violation when any `journal_entries` row exists for the business. A second, unattached function `enforce_business_currency_immutable()` implements the same rule — duplicated policy logic.
- **Your KES → INR attempt.** The business `Joshua Holdings` (base `KES`) has 17 journal entries. That trigger is the most likely source of the HTTP 400, but the exact returned error string has not yet been captured. Treated as **UNKNOWN — requires verification** until reproduced and the PostgREST error body is read.
- **A rate authority exists.** `resolve_exchange_rate` → `_pick_exchange_rate_row` defines one precedence rule: latest `effective_date` first, then business-scoped over org-scoped, then `override` > `manual` > provider, then newest `published_at`. `require_exchange_rate` refuses to invent a rate. Provider rows are immutable (`_tg_exchange_rates_immutable_provider`).
- **FX machinery exists**: `fx_revaluation_runs` / `fx_revaluation_lines`, `revalue_fx_balances`, `reverse_fx_revaluation_run`, `fx_realized_gain_loss`, `fx_exposure_*`, `resolve_fx_realized_account` / `resolve_fx_unrealized_account`.
- **Documents stamp their own rate**: `invoices`, `credit_notes`, `estimates`, `sales_orders`, `purchase_orders`, `customer_refunds`, `journal_entries`, `journal_entry_lines`, `bank_transactions` all carry `exchange_rate`, with `_tg_stamp_*_currency` triggers per document type.
- **Browser conversion is fenced**: `CurrencyContext.convertCurrency` returns `null` rather than guessing, delegating to the single engine at `src/services/fx/rateBook.ts`, and a suite of architecture tests (`fx-single-engine`, `no-silent-currency-fallback`, `fx-tenant-isolation`, `currency-integrity`, …) already asserts these invariants.
- **Two gaps visible without deeper work**: `bills` and `bank_accounts` carry `currency` but no `exchange_rate` column, unlike their sales counterparts; and `exchange_rates` RLS is `user_can_access_business(auth.uid(), business_id)` while `business_id` is nullable for org-scoped rows — the behaviour of that predicate on NULL is **UNKNOWN — requires verification** and is a potential isolation defect in either direction (rows invisible, or rows over-visible).

So the audit does **not** start from "base currency is freely mutable". It starts from "a currency architecture exists and looks deliberate — prove whether it is complete, consistent, and correctly scoped."

## Audit waves

Each wave produces evidence tagged FACT / STD / INFER / UNKNOWN. Nothing is asserted without a citation to a schema object, a function body, a file, a query result, or a vendor document.

**Wave 0 — Reproduce the 400.** Drive the Currency Settings UI in a browser against the live app, capture the exact PostgREST response body and SQL error for KES → INR on Joshua Holdings, and trace UI → hook → REST → trigger. Confirm or refute the currency-lock hypothesis.

**Wave 1 — Domain model and scope hierarchy.** Map every term in your list (platform / tenant / business / branch / base / transaction / reporting currency, catalogue, rate book, override, lock, historical rate, realized vs unrealized FX, precision, formatting) to the actual object that implements it, or record it as absent. Determine which entity is the accounting entity whose books have a home currency, and whether branches are modelled as sub-ledgers or as entities. Compare against QuickBooks, Odoo, NetSuite, and Dynamics 365 Business Central using official documentation, noting where they differ rather than flattening them.

**Wave 2 — Security and isolation.** Read every RLS policy and grant on `currencies`, `platform_exchange_rates`, `exchange_rates`, `business_active_currencies`, `fx_revaluation_runs/lines`, and prove or disprove: cross-business rate visibility, the nullable-`business_id` predicate above, whether `SECURITY DEFINER` FX functions validate business ownership, and whether one business's override can be consumed by another's conversion.

**Wave 3 — Base currency lifecycle.** Establish the real lifecycle states and the guard at each boundary: draft transactions, first posted entry, first foreign transaction, first reconciliation, first closed period, first revaluation. Test whether the current single guard (`journal_entries` exist) is the right boundary or too narrow — e.g. whether draft invoices, bank accounts in other currencies, or opening balances can exist before the lock engages. Reason through the full KES → INR corruption scenario (AR, AP, bank, inventory, fixed assets, depreciation, budgets, reconciliations, closed periods, reports, audit history) and state what a bare row update would mean for each.

**Wave 4 — Rate authority and historical evidence.** Confirm the precedence rule is the only one in the system, that no module re-implements it, and that every posted document permanently retains transaction currency, amount, base currency, base amount, rate, rate date, source, and override status. Verify a later rate change cannot retroactively restate a posted document. Investigate the `bills` / `bank_accounts` missing-rate-column asymmetry. Check the guards for missing rate, zero rate, negative rate, and high-precision rounding.

**Wave 5 — Consumer sweep.** Enumerate every currency-consuming business event across Sales, Purchases, Banking, GL, AR/AP, Inventory, Fixed Assets, Budgets, Payroll, POS, and Reporting. For each: where the rate comes from, who converts, server or client, historical or current, persisted or recomputed, authoritative or derived. Identify any competing conversion implementation.

**Wave 6 — FX gains/losses and closed periods.** Trace invoice → open foreign balance → rate move → revaluation → settlement → realized FX end to end against the existing functions. Determine what exists, what is missing, and whether period close blocks rate edits, override edits, revaluation, and reversals.

**Wave 7 — Formatting vs mathematics.** Verify presentation (symbol, ISO code, minor units, separators, grouping, negatives, locale) is fully separated from accounting conversion, specifically for KES, USD, GBP, EUR, INR, UGX, TZS, JPY — confirming INR grouping and JPY zero-decimal are presentation-layer only.

**Wave 8 — Edge-case matrix and UI.** Work the full scenario matrix you listed, then — only after the domain model is proven — assess the Currency Settings page for collapsed concepts, catalogue scale, missing search/filter/enabled-only views, override and source indicators, effective-date views, and destructive-change warnings.

## Final report structure

The report will follow your section list exactly: verdict, domain model, lifecycle, scope model, base-currency lifecycle, rate lifecycle, business-event map, confirmed defects (each with FACT + evidence + consequence + severity), missing capabilities, dangerous capabilities, security/isolation defects, accounting-correctness defects, lifecycle defects, architecture defects, UI/UX defects, enterprise comparison, and a dependency-ordered rework contract. Phases in that contract will be derived from what the evidence shows — each stating what changes, why, dependencies, what must not change, validation, and the accounting and security invariants it preserves.

## Ground rules held throughout

No guessing; gaps are recorded as UNKNOWN. The UI does not define the business model. An existing constraint is not assumed correct. Vendor behaviours are not assumed identical. No accounting logic moves into React. No implementation, migration, or data change happens in this wave.
