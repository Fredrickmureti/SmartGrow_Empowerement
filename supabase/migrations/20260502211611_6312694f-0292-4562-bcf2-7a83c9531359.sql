-- Repair affected DRAFT invoices whose header subtotal/total was previously
-- persisted using the old buggy formula `subtotal = SUM(line_total - tax_amount)`.
-- The frontend now correctly persists invoice_items.line_total as tax-EXCLUSIVE,
-- and the canonical header rule is:
--   invoices.subtotal   = SUM(invoice_items.line_total)
--   invoices.tax_amount = SUM(invoice_items.tax_amount)
--   invoices.total      = subtotal + tax_amount - discount_amount
--
-- This migration only touches drafts (never posted/sent/paid invoices).
-- It re-rolls header totals from the existing line data WITHOUT modifying
-- line rows, because lines were already corrected by the prior repair.
WITH rolled AS (
  SELECT
    invoice_id,
    ROUND(SUM(line_total)::numeric, 2)        AS subtotal,
    ROUND(SUM(COALESCE(tax_amount, 0))::numeric, 2) AS tax_amount
  FROM public.invoice_items
  WHERE invoice_id IN (SELECT id FROM public.invoices WHERE status = 'draft')
  GROUP BY invoice_id
)
UPDATE public.invoices i
SET
  subtotal   = r.subtotal,
  tax_amount = r.tax_amount,
  total      = ROUND(r.subtotal + r.tax_amount - COALESCE(i.discount_amount, 0), 2)
FROM rolled r
WHERE i.id = r.invoice_id
  AND (
       ABS(COALESCE(i.subtotal, 0)   - r.subtotal)   > 0.01
    OR ABS(COALESCE(i.tax_amount, 0) - r.tax_amount) > 0.01
    OR ABS(COALESCE(i.total, 0) - ROUND(r.subtotal + r.tax_amount - COALESCE(i.discount_amount, 0), 2)) > 0.01
  );