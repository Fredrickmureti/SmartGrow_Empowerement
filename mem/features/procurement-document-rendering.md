---
name: Procurement documents are never invoices
description: RFQ/requisition PDFs use the procurement layouts (no prices, no Bill To, no totals); render-document must be redeployed after any _shared/pdf or _shared/rendering change
type: feature
---

# Procurement document rendering

- `purchases.rfq` → `generateSolicitationPdf`, `purchases.requisition` →
  `generateRequisitionPdf` (`supabase/functions/_shared/pdf/layouts/procurement.ts`),
  routed by `PROCUREMENT_LAYOUTS` in `_shared/rendering/renderers/pdf.ts`.
  An RFQ asks for a price and must never state one; a requisition is internal
  and must never carry "Bill To", tax/amount columns, totals, or a
  "Thank you for your business!" footer.
- Snapshot builders in `src/services/documents/snapshots/` strip all monetary
  fields for these kinds. Never add them back.
- Money is coerced through `coerceFinite` in `_shared/format/currency.ts`:
  NaN/Infinity/null degrade to `0.00`. Documents never print `NaN`.
- `document_records` stores the number in `document_number` (not `number`) —
  `resolveContext.loadDocument` reads that column; otherwise
  `document_artifacts.document_number` silently persists as null.
- **Deploy rule:** `_shared/**` is bundled per function. After touching
  `_shared/pdf`, `_shared/rendering`, `_shared/format` or `_shared/reports`,
  redeploy `render-document`, `generate-document`, `render-report` AND
  `process-scheduled-reports`, or a stale bundle keeps serving the old layout
  (this is exactly how the invoice-shaped RFQ regression shipped).

Guard: `supabase/functions/_shared/pdf/__tests__/procurement-not-invoice_test.ts`.
