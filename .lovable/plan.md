# Sales Domain Architecture Wave — Authoritative Status

_Active phase: **Phase 4 — server-authoritative pricing**. Milestones 1, 2 and 4 independently RE-VERIFIED against the live database this session. Milestone 3 (tax + document totals) confirmed genuinely PENDING and is the work of this iteration._

## Phase 3 — The line quantity contract (COMPLETE, re-verified)

- `resolve_line_base_quantity(p_business_id, p_product_id, p_display_quantity, p_display_uom_id, p_packaging_id)` exists and is the single conversion authority (packaging multiplier wins, alternate UoM via `convert_uom`, cross-dimension fails closed).
- `_uom_normalize_line()` attached via `trg_uom_normalize_*` to `invoice_items`, `sales_order_items`, `estimate_items`, `credit_note_items`, `proforma_invoice_items`; `delivery_note_items` uses `trg_uom_stamp_delivery_note_items` (`_uom_stamp_delivery_line`). `enforce_line_uom_consistency` additionally guards each line table.
- `uom_snapshot` frozen server-side. Frontend packaging/UoM selection is preview only.

Out of scope by design: `CreditNoteEditPage` (lines locked, no product picker).

## Phase 4 — Server-authoritative pricing

### Milestones 1, 2, 4 — VERIFIED COMPLETE (evidence, not trust)

- `resolve_line_unit_price(p_business_id, p_product_id, p_contact_id, p_packaging_id, p_display_uom_id, p_display_quantity)` exists; precedence customer price list > business price book > product scalar, unit-aware.
- `_pricing_normalize_line()` source read in full: lines carrying an explicit non-zero `unit_price` are preserved and labelled `manual`; otherwise business/contact are resolved from the parent header per line table and `unit_price` + `price_source` are stamped, with the customer-group discount applied only when the line carries none.
- Exactly one `trg_zz_pricing_normalize_*` trigger on each of the five line tables, ordered after `trg_uom_normalize_*` by name.
- `price_source` column present on all five line tables.
- `src/hooks/useLinePriceResolver.ts` exists and is consumed by Sales Order create/edit, Estimate create/edit, Invoice create/edit, Proforma create and Credit Note create.

No rework required on milestones 1, 2 or 4. Residual note: no `product_packaging` / `price_list_items` rows exist in the current dataset, so packaging-specific and tiered precedence remain logic-verified only.

### Milestone 3 — server-side tax and document totals (ACTIVE)

Confirmed defect, with evidence:
- No trigger matching `%total%` exists on any of the five Sales line tables — the database does not own totals at all.
- `src/lib/invoiceLineMath.ts` (`computeLine` / `computeTotals`) is authoritative today: the browser computes line `tax_amount` and `line_total`, and `useInvoices.ts` sums header `subtotal / tax_amount / total` before insert. A stale or tampered client can persist a financially inconsistent document.
- Line tax comes from a client-held `tax_rate` scalar, while the canonical tax master is `public.tax_rates` (business-scoped: `rate`, `is_inclusive`, `is_compound`, `tax_type`, `effective_from/to`, `is_active`, `is_default`) referenced by `products.tax_rate_id`. Sales is bypassing the canonical tax domain.

Canonical engines to consume — do NOT build new ones: `tax_rates` + `products.tax_rate_id`, `resolve_product_tax_localization` for jurisdiction codes, `resolve_line_unit_price`, `resolve_line_base_quantity`, `post_journal_entry_atomic` for GL.

Implementation:

1. **`public.resolve_line_tax_rate(p_business_id, p_product_id, p_contact_id, p_date)`** — new, thin, single-purpose. Precedence: customer exemption/override where the contact carries one > `products.tax_rate_id` → the `tax_rates` row active and effective on `p_date` > the business default (`is_default`) > zero. Returns `{rate, tax_rate_id, is_inclusive, source}`. Country agnostic: no hardcoded rate, no country-specific branch.
2. **Stamp tax and line totals server-side.** New `_totals_normalize_line()` attached as `trg_zzz_totals_*` (after the pricing trigger) on the five line tables. From the stamped `unit_price` and the canonical base quantity it computes `discount_amount`, `tax_rate`, `tax_amount` and `line_total` (tax-exclusive, matching the contract already documented in `invoiceLineMath.ts`), back-solving the exclusive base when the resolved rate `is_inclusive`. Client-supplied amounts are recomputed, never trusted.
3. **Document totals owned by the database.** `_recalc_document_totals()` fires on line insert/update/delete and recomputes header `subtotal`, `tax_amount`, `total` (= subtotal + tax − header discount) on `invoices`, `sales_orders`, `estimates`, `credit_notes`, `proforma_invoices`. A header guard rejects direct writes to total columns that disagree with the line sum, so totals cannot be forged from the browser.
4. **Demote the client.** `computeLine` / `computeTotals` keep their signatures but become display preview only; the Sales editors and `useInvoices.ts` stop persisting line tax/line totals and header totals as authoritative values.
5. **Immutability respected.** Recalculation is skipped for documents already in posted/immutable states, so historical facts are never silently mutated; corrections keep flowing through credit notes and reversals.

Verification for this milestone:
- SQL: a line inserted with no price gets price, tax and line total stamped; a manual price still taxes correctly; an inclusive rate nets to the same total as the exclusive equivalent; deleting a line updates the header; a header total write that disagrees with the lines is rejected.
- Update `src/test/architecture/invoice-totals-contract.test.ts` and `src/lib/__tests__/invoiceLineMath.test.ts` to assert preview-only status and parity with the SQL contract.
- `tsgo --noEmit` clean.

## Phases beyond 4 (recorded, not started)

- **Phase 5 — availability / fulfilment contract.** Verify Sales asks Inventory/Warehouse for availability and allocation instead of computing stock; confirm branch scope on the reservation path.
- **Phase 6 — invoice ↔ receivables boundary.** Confirm Sales posts only through `post_journal_entry_atomic` and never writes journal rows directly.
- **Phase 7 — returns / credit notes.** Ownership of stock movement on return acceptance (`resolve_sales_return_line_tax` already exists — reuse, do not duplicate).
- **Phase 9 — concurrency / idempotency** on order confirm, invoice issue and payment capture.

## Instructions for the next agent

Milestones 1, 2 and 4 are verified — do not re-audit them. Start from Milestone 3 above, land it across all five Sales document types in one migration plus the client demotion, then update this file before opening Phase 5.
