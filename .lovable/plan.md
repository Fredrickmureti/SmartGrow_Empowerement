# Sales Domain Architecture Wave — Authoritative Status

_Active phase: **Phase 4 COMPLETE** (milestones 1–4, all verified live). Next: **Phase 5 — availability / fulfilment contract**._

## Verification verdict on the previous engineer's work (this session)

Every milestone-1/2/4 claim was re-checked against the live database and codebase, not taken on trust.

| Claim | Verdict | Evidence |
|---|---|---|
| `resolve_line_base_quantity` is the single quantity authority | TRUE | function exists; `trg_uom_normalize_*` on all 5 Sales line tables, `trg_uom_stamp_delivery_note_items` on delivery lines, `enforce_line_uom_consistency` additionally guards each |
| `resolve_line_unit_price` + `_pricing_normalize_line` stamp price server-side | TRUE | function source read in full: manual prices preserved and labelled `manual`; business/contact resolved from the parent header per line table; exactly one `trg_zz_pricing_normalize_*` per line table, ordered after the UoM trigger |
| `price_source` on all five line tables | TRUE | column present on `invoice_items`, `sales_order_items`, `estimate_items`, `credit_note_items`, `proforma_invoice_items` |
| Editors preview the server price | TRUE | `useLinePriceResolver` consumed by SO create/edit, Estimate create/edit, Invoice create/edit, Proforma create, Credit Note create |
| "`tsgo --noEmit` clean" | **FALSE** | `CreditNoteCreatePage.tsx` TS2448 — `applyServerPrice` used before declaration; the Credit Note create editor did not compile. **Fixed this session** (hook declarations hoisted above `patchLineItem`); `tsgo` now clean |
| Milestone 3 (tax + totals) pending | TRUE | no `%total%` trigger existed on any Sales line table; browser was authoritative |

Residual: no `product_packaging` / `price_list_items` rows exist in the dataset, so packaging-specific and tiered price precedence remain logic-verified only.

## Phase 3 — line quantity contract (COMPLETE, re-verified)

`resolve_line_base_quantity(p_business_id, p_product_id, p_display_quantity, p_display_uom_id, p_packaging_id)` is the single conversion authority (packaging multiplier wins, alternate UoM via `convert_uom`, cross-dimension fails closed). `uom_snapshot` frozen server-side. Frontend packaging/UoM selection is preview only. Out of scope by design: `CreditNoteEditPage` (lines locked, no product picker).

## Phase 4 — Server-authoritative pricing, tax and totals (COMPLETE)

### Milestones 1, 2, 4 — verified above. Milestone-4 compile defect fixed.

### Milestone 3 — server-side tax and document totals (IMPLEMENTED + VERIFIED LIVE)

Defect closed: the browser (`src/lib/invoiceLineMath.ts` + `useInvoices.ts`) was authoritative for line `tax_amount` / `line_total` and header `subtotal / tax_amount / total`, and line tax came from a client scalar while the canonical master `public.tax_rates` (referenced by `products.tax_rate_id` and `contacts.default_tax_rate_id`) was bypassed.

Shipped (one migration, no new engines — the canonical `tax_rates` master is consumed):

1. **`public.resolve_line_tax_rate(p_business_id, p_product_id, p_contact_id, p_date)`** → `{rate, tax_rate_id, is_inclusive, source}`. Precedence: valid customer exemption (`contacts.tax_exemption_number` + expiry) > `contacts.default_tax_rate_id` > `products.tax_rate_id` > business `is_default` rate > legacy `products.tax_rate` scalar > zero. Honours `is_active` and `effective_from/to`. `SECURITY DEFINER`, `authenticated` + `service_role` only, `anon`/`PUBLIC` revoked. Country agnostic — no hardcoded rate or jurisdiction branch.
2. **`_totals_normalize_line()`** — `trg_zzz_totals_*` BEFORE INSERT/UPDATE on all five line tables, sorting after the pricing trigger. Recomputes `tax_rate` (resolver-owned for product lines; operator value kept for free-text lines), `discount`, `tax_amount` and `line_total` (tax-EXCLUSIVE) from the stamped `unit_price` × canonical base quantity, back-solving the exclusive base when the resolved rate `is_inclusive`. Client amounts are recomputed, never trusted.
3. **`_recalc_document_totals()`** — `trg_recalc_totals_*` AFTER INSERT/UPDATE/DELETE on the five line tables; derives header `subtotal`, `tax_amount`, `total` (= subtotal + tax − `discount_amount`, which `credit_notes` does not carry) on `invoices`, `sales_orders`, `estimates`, `credit_notes`, `proforma_invoices`.
4. **`_sales_header_totals_guard()`** — `trg_zzz_header_totals_*` BEFORE INSERT/UPDATE on the five headers. A client total that disagrees with the lines is rewritten to the line-derived value (recalc writes bypass it via the transaction-local `sales.totals_recalc` flag). Header inserts with no lines yet are untouched.
5. **Immutability respected** — `_sales_doc_is_mutable(table, status)` gates both the line stamp and the recalc, so posted / confirmed / paid / cancelled / voided documents are never silently re-costed. Corrections continue to flow through credit notes and reversals.
6. **Client demoted** — `src/lib/invoiceLineMath.ts` is now documented and guarded as PREVIEW-ONLY, naming the server functions that own the numbers.

Verification evidence (live database, executed this session):
- Inserted a line into a draft invoice with a forged `tax_amount`/`line_total` of `999` and `unit_price` 0 → server stamped `unit_price 80` (`price_source = product`), `tax_rate 16`, `tax_amount 25.60`, `line_total 160.00`; header moved `105 / 0 / 105` → `265.00 / 25.60 / 290.60`.
- Direct header write `subtotal = tax = total = 1` → guard rewrote it back to `265.00 / 25.60 / 290.60`.
- Deleting the line restored the header to `105.00 / 0.00 / 105.00`. Fixture removed.
- `src/test/architecture/invoice-totals-contract.test.ts` extended with preview-only + SQL-parity guards; `invoiceLineMath` suite green (14 tests).
- `supabase/tests/sales_line_totals_server_authority_test.sql` added: asserts one resolver, 5+5+5 triggers, pricing-before-totals ordering, resolver precedence and effective dating, on isolated rolled-back fixtures.
- `tsgo --noEmit` clean.

## Phase 5 — Availability / fulfilment contract (NEXT, not started)

Determine how Sales asks "can this be fulfilled?" and prove Sales never computes stock itself. Verify: the canonical availability/reservation RPC, branch and warehouse scope on that path, partial fulfilment and backorders (`backorders` table exists), and concurrent allocation of the same quant.

## Later phases (recorded)

- **Phase 6 — invoice ↔ receivables boundary.** Confirm Sales posts only through `post_journal_entry_atomic` (ADR 0123) and never writes journal rows directly; check `validate_document_gl_integrity` still agrees with the new server-derived totals for posted invoices.
- **Phase 7 — returns / credit notes.** Ownership of stock movement on return acceptance; `resolve_sales_return_line_tax` already exists — reuse, do not duplicate.
- **Phase 8 — recurring sales.** Prove recurring generation reuses the invoice/tax/pricing path rather than a parallel one.
- **Phase 9 — concurrency / idempotency** on order confirm, invoice issue and payment capture.

## Known follow-ups created by this milestone

- `_totals_normalize_line` resolves tax as of `CURRENT_DATE` rather than the document's issue date; when back-dated documents matter, pass the header date (column names differ per document type — confirm each before wiring).
- Seed `product_packaging` and `price_list_items` rows and re-confirm packaging-specific and tiered price precedence end to end.
- Sales editors still send `tax_amount` / `line_total` in their payloads. Harmless (the server overwrites them) and deliberately kept so NOT NULL holds on the immutable-document path, but the editors should re-read the saved document rather than trusting their local preview.

## Instructions for the next agent

Phase 4 is closed and verified — do not re-audit it. Start at Phase 5 above.
