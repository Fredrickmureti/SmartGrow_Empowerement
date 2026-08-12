# Project status — authoritative

Last updated: 2026-08-12

## Completed and verified

### Wave: Transaction reversal fabric (CLOSED)
- Preview enrichment: `preview_reversal_extras_expense`, `preview_reversal_extras_customer_refund`,
  dispatched from `preview_reversal_consequences`. Helpers revoked from PUBLIC/anon/authenticated,
  reachable only via the SECURITY DEFINER wrapper.
- Expense void path verified end to end (reason codes, payroll-queue interlock, approval gate,
  `VoidExpenseDialog`).
- `ReverseCustomerRefundSheet` on the customer ledger — resolves intent, renders the honest
  server-side block, routes to the corrective receipt.
- ADR 0134 written.
- Guards: `reversal-intent-coverage.test.ts` (client entry point per reversible doc type,
  preview-extras dispatch). Green.

### Wave: Supplier currency / FX integrity (CLOSED)
Root cause established by investigation (archived at
`.lovable/plan/supplier-default-currency-root-cause-investigation-remediati-2026-08-12.md`):
`suppliers.default_currency` was unvalidated free text with zero readers, sitting on top of a
purchasing stack that had literal `'USD'`/`'KES'` header defaults, no AP-side rate resolver and an
empty rate book — so foreign-currency bills posted 1:1 silently.

Delivered:
- DB: `normalize_currency_code`, currency-validation triggers on `suppliers` and `contacts`,
  unified `resolve_exchange_rate` (+ `require_exchange_rate`), `resolve_sales_exchange_rate`
  reduced to a shim.
- DB: literal currency defaults dropped from `bills`, `purchase_orders`, `vendor_credit_notes`,
  `purchase_returns` (verified: all four now have `NULL` default); `_tg_stamp_*_currency` triggers
  derive currency from base, validate, and stamp the rate. Posted bills / VCNs are currency- and
  rate-immutable.
- Client: `useSupplierDocumentCurrency` (supplier → contact → base, via `resolve_supplier_defaults`)
  now drives bill and PO creation; `CurrencyCombobox` replaces the free-text inputs on
  `SupplierCreatePage` and the Supplier Terms tab.
- ADR 0135 written; memory `mem://features/currency-and-fx-resolution` recorded.
- Guard: `src/test/architecture/currency-integrity.test.ts` — green, alongside
  `supplier-purchasability-gate` and `reversal-intent-coverage`.

## Known open item (deliberate, not a defect)
`public.exchange_rates` is empty. By design, a non-base-currency purchasing document now fails
loudly rather than posting unconverted. Seeding / sourcing rates is the next functional milestone,
not a regression.

## Active phase
None — both waves closed.

## Next milestone (in roadmap order)
1. **Exchange-rate sourcing** — decide the rate book's write path (manual entry surface, then
   scheduled provider ingest), seed `business_active_currencies`, and add an admin FX screen.
   Only after that is multi-currency purchasing usable end to end.
2. **Reversal governance coverage** — extend approval-gated reversal to `vendor_credit_note`
   (the one reversible type without a governance gate).

## Instructions for the next agent
1. Verify first: run `bunx vitest run src/test/architecture/currency-integrity.test.ts
   src/test/architecture/reversal-intent-coverage.test.ts
   src/test/architecture/supplier-purchasability-gate.test.ts`, then confirm in the database that
   the four purchasing tables still have no literal currency default and that the
   `_tg_stamp_*_currency` triggers are attached. Read ADR 0134 and ADR 0135 before touching either
   area.
2. Then resume at milestone 1 above. Do not start unrelated work, and do not leave a phase
   partially implemented.
3. Note: the full `src/test` suite times out under sandbox contention; that is environmental and
   pre-existing. Run targeted suites.
