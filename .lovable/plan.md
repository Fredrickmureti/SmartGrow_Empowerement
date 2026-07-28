## Goal
Make Sales and Purchases documents respect the operator's print policy: if the policy says `80mm/58mm/40mm + escpos + receipt_thermal/receipt_printer`, the job must render ESC/POS bytes and dispatch to the registered thermal printer; if the policy says A4/Letter/A5 PDF, it must keep using the browser/A4 path.

## Confirmed diagnosis
The current source and live job evidence point to a server-side policy blockade, not a missing device or UI-only bug:

- Sales/Purchases pages already use the unified document pipeline: snapshot → document record → `printDocumentIntent` → `print_jobs` → render → dispatch.
- The operator policy UI allows invoices, sales orders, purchase orders, bills, etc. to be configured for `escpos` and thermal paper widths.
- The authoritative database resolver `resolve_output_intent` hard-coerces every non-`pos_receipt` / non-`kitchen_ticket` business document back to `medium='pdf'`, `paper_format='a4'`, and `hardware_role='a4_printer'`.
- Recent jobs show that exact symptom via `render_params.coerced_to_pdf=true`.

## Implementation plan

1. **Fix the authoritative routing resolver**
   - Add a Supabase migration that replaces `public.resolve_output_intent` so Sales/Purchases document kinds can use thermal ESC/POS when their policy explicitly requests:
     - `render_mode = 'escpos'`
     - `paper_format IN ('40mm','58mm','80mm')`
     - a printer role whose `hardware_kind` resolves to a thermal-capable role such as `receipt_printer` / `receipt_thermal`
   - Keep PDF as the safe default when no policy exists.
   - Keep A4/Letter/A5 policies routed to `a4_printer` / PDF.
   - Keep `copies`, branch overrides, and business-level fallback behavior unchanged.
   - Keep the resolver auditable, but remove the false `coerced_to_pdf` outcome for valid thermal business-document policies.

2. **Align renderer coercion with the new rule**
   - Update the shared print-policy coercion logic used by `generate-document` so explicit ESC/POS requests for Sales/Purchases thermal policies are not forced back to PDF.
   - Preserve explicit PDF behavior for download/email/preview flows so a user can still save or print an A4 invoice.
   - Ensure `invoice`, `sales_order`, `estimate`, `proforma`, `credit_note`, `delivery_note`, `sales_return`, `purchase_order`, `bill`, `vendor_statement`, `purchase_return`, `grn`, and statements are treated as printable document artifacts, not POS-only receipts.

3. **Use the existing shared thermal row producer**
   - Keep using `documentToReceiptLines` → `renderDocumentEscPos` for ESC/POS output.
   - Verify Sales/Purchases snapshots already contain the fields the receipt-line renderer needs: document number/date, party, totals, tax, items, currency, notes/terms.
   - Add only minimal mapping/fallbacks if a business document field is missing from thermal output; do not create a separate Sales/Purchases thermal renderer.

4. **Make dispatch target the selected device role**
   - Ensure queued jobs created from policies carry the hardware role resolved from `printer_roles`, so Sales invoices can go to one receipt printer and POS receipts can go to another if the operator configured them that way.
   - Do not hardcode device IDs or printer names.
   - Preserve the existing `resolve_device`/`device_assignments` model.

5. **Add regression coverage**
   - Update or add architecture/unit tests proving:
     - an invoice policy with `80mm + escpos + thermal role` resolves to ESC/POS/thermal, not `coerced_to_pdf`.
     - a purchase order policy with `58mm + escpos` resolves to ESC/POS/thermal.
     - an invoice policy with A4/PDF still resolves to PDF/A4.
     - POS receipts and labels continue using their existing working paths.
   - Update docs/ADR notes to reflect that Sales/Purchases business documents are allowed to route to thermal when the operator explicitly configures them.

6. **Validate against the real failure signal**
   - After implementation, inspect newly enqueued invoice/PO jobs and confirm:
     - `medium`/render params resolve to ESC/POS for thermal policies.
     - `coerced_to_pdf` is absent/false for valid thermal policies.
     - the dispatch path reaches the thermal device assignment instead of the browser/A4 printer.

## Non-goals
- Do not create a new printing architecture.
- Do not add legacy fallbacks or a second Sales/Purchases print path.
- Do not bypass policies by printing directly from Sales/Purchases pages.
- Do not remove A4/Letter/A5/browser print support.