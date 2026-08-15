---
name: sales-sale-time-tax
description: Phase 7 invariants — resolve_sales_line_tax is the single sale-time tax authority for every Sales line; the browser only previews it.
type: feature
---
- `public.resolve_sales_line_tax(p_business_id, p_product_id, p_contact_id, p_date, p_tax_rate_id, p_requested_rate)` is the ONE sale-time tax decision. It is called by the `_totals_normalize_line()` trigger on `invoice_items`, `sales_order_items`, `estimate_items`, `credit_note_items`, `proforma_invoice_items`.
- Tax is resolved as at the **document's own date** (`invoices.issue_date`, `sales_orders.order_date`, …), never `CURRENT_DATE`.
- An explicit line `tax_rate_id` must be the same company's, active and in force, else 22023. A free-text (non-product) line with a rate that is not a configured live rate is rejected. Compound rates raise 0A000 — one tax per line.
- Tax-inclusive prices are unwound (`gross / (1 + rate/100)`) before discount and tax; `fixed_amount` is a per-unit levy added to the percentage component.
- The product cascade (exemption > customer default > product > company default) stays in `resolve_line_tax_rate`; `resolve_sales_line_tax` wraps and validates it.
- Every line stores the applied `tax_rate_id` as an audit snapshot.
- Client seam is PREVIEW ONLY: `src/features/sales/tax/salesLineTaxPreview.ts` (`previewSalesLineTax`, `previewCustomerTaxRate`). Sales editors must never query `tax_rates` to decide a rate — guard: `src/test/architecture/sales-tax-authority.test.ts`.
