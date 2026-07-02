-- ============================================================================
-- Data repair: tax-EXCLUSIVE line_total contract
-- ----------------------------------------------------------------------------
-- The frontend was previously persisting invoice_items.line_total as
-- (subtotal_after_discount + tax) — i.e. tax-INCLUSIVE — while the
-- confirm_invoice_atomic validator and GL posting logic require it to be
-- tax-EXCLUSIVE (== subtotal_after_discount). This caused
-- SUM(items.line_total) ≈ invoices.subtotal to fail whenever tax > 0.
--
-- Scope: ONLY documents in editable / unposted states (draft).
-- We never touch confirmed/sent/paid/posted documents — those have already
-- been validated, GL-posted, and may be referenced by payments, credit notes,
-- or stock movements. Any historical mismatches there must be handled via a
-- separate, audited correction process, not a blanket UPDATE.
--
-- Order of operations per table:
--   1. Recompute item.tax_amount from (qty * price * (1 - disc%)) * tax_rate%
--   2. Recompute item.line_total as tax-EXCLUSIVE subtotal_after_discount
--   3. Roll header subtotal / tax_amount / total up from corrected items
-- All math uses ROUND(..., 2) to match the canonical computeLine() helper.
-- ============================================================================

-- ---------- INVOICES (draft only) -------------------------------------------
WITH editable AS (
  SELECT id FROM public.invoices WHERE status = 'draft'
)
UPDATE public.invoice_items ii
SET
  tax_amount = ROUND(
    (COALESCE(ii.quantity, 0) * COALESCE(ii.unit_price, 0))
    * (1 - COALESCE(ii.discount_percent, 0) / 100.0)
    * (COALESCE(ii.tax_rate, 0) / 100.0)
  , 2),
  line_total = ROUND(
    (COALESCE(ii.quantity, 0) * COALESCE(ii.unit_price, 0))
    * (1 - COALESCE(ii.discount_percent, 0) / 100.0)
  , 2)
FROM editable e
WHERE ii.invoice_id = e.id;

WITH rolled AS (
  SELECT
    invoice_id,
    ROUND(SUM(line_total)::numeric, 2)  AS subtotal,
    ROUND(SUM(tax_amount)::numeric, 2)  AS tax_amount
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
WHERE i.id = r.invoice_id;

-- ---------- ESTIMATES (draft only) ------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'estimate_items'
  ) THEN
    EXECUTE $sql$
      WITH editable AS (
        SELECT id FROM public.estimates WHERE status = 'draft'
      )
      UPDATE public.estimate_items ei
      SET
        tax_amount = ROUND(
          (COALESCE(ei.quantity, 0) * COALESCE(ei.unit_price, 0))
          * (1 - COALESCE(ei.discount_percent, 0) / 100.0)
          * (COALESCE(ei.tax_rate, 0) / 100.0)
        , 2),
        line_total = ROUND(
          (COALESCE(ei.quantity, 0) * COALESCE(ei.unit_price, 0))
          * (1 - COALESCE(ei.discount_percent, 0) / 100.0)
        , 2)
      FROM editable e
      WHERE ei.estimate_id = e.id;
    $sql$;

    EXECUTE $sql$
      WITH rolled AS (
        SELECT
          estimate_id,
          ROUND(SUM(line_total)::numeric, 2) AS subtotal,
          ROUND(SUM(tax_amount)::numeric, 2) AS tax_amount
        FROM public.estimate_items
        WHERE estimate_id IN (SELECT id FROM public.estimates WHERE status = 'draft')
        GROUP BY estimate_id
      )
      UPDATE public.estimates es
      SET
        subtotal   = r.subtotal,
        tax_amount = r.tax_amount,
        total      = ROUND(r.subtotal + r.tax_amount - COALESCE(es.discount_amount, 0), 2)
      FROM rolled r
      WHERE es.id = r.estimate_id;
    $sql$;
  END IF;
END $$;

-- ---------- CREDIT NOTES (draft only) ---------------------------------------
-- Credit notes use a simpler model (no discount_percent on lines).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'credit_note_items'
  ) THEN
    EXECUTE $sql$
      WITH editable AS (
        SELECT id FROM public.credit_notes WHERE status = 'draft'
      )
      UPDATE public.credit_note_items ci
      SET
        tax_amount = ROUND(
          COALESCE(ci.quantity, 0) * COALESCE(ci.unit_price, 0)
          * (COALESCE(ci.tax_rate, 0) / 100.0)
        , 2),
        line_total = ROUND(
          COALESCE(ci.quantity, 0) * COALESCE(ci.unit_price, 0)
        , 2)
      FROM editable e
      WHERE ci.credit_note_id = e.id;
    $sql$;

    EXECUTE $sql$
      WITH rolled AS (
        SELECT
          credit_note_id,
          ROUND(SUM(line_total)::numeric, 2) AS subtotal,
          ROUND(SUM(tax_amount)::numeric, 2) AS tax_amount
        FROM public.credit_note_items
        WHERE credit_note_id IN (SELECT id FROM public.credit_notes WHERE status = 'draft')
        GROUP BY credit_note_id
      )
      UPDATE public.credit_notes cn
      SET
        subtotal   = r.subtotal,
        tax_amount = r.tax_amount,
        total      = ROUND(r.subtotal + r.tax_amount, 2)
      FROM rolled r
      WHERE cn.id = r.credit_note_id;
    $sql$;
  END IF;
END $$;
