
-- 1. Add frozen unit label to POS lines.
ALTER TABLE public.pos_transaction_items
  ADD COLUMN IF NOT EXISTS uom_snapshot text;

-- 2. Extend provenance trigger to cover all transaction reference types.
CREATE OR REPLACE FUNCTION public._backfill_movement_packaging()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_pkg uuid; v_uom uuid;
BEGIN
  IF NEW.reference_id IS NULL OR NEW.product_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.source_packaging_id IS NOT NULL AND NEW.source_uom_id IS NOT NULL THEN RETURN NEW; END IF;

  CASE NEW.reference_type
    WHEN 'invoice' THEN
      SELECT packaging_id, display_uom_id INTO v_pkg, v_uom FROM public.invoice_items
       WHERE invoice_id = NEW.reference_id AND product_id = NEW.product_id
       ORDER BY (packaging_id IS NOT NULL) DESC, created_at ASC NULLS LAST LIMIT 1;
    WHEN 'delivery_note' THEN
      SELECT packaging_id, display_uom_id INTO v_pkg, v_uom FROM public.delivery_note_items
       WHERE delivery_note_id = NEW.reference_id AND product_id = NEW.product_id
       ORDER BY (packaging_id IS NOT NULL) DESC, created_at ASC NULLS LAST LIMIT 1;
    WHEN 'goods_receipt' THEN
      SELECT packaging_id, display_uom_id INTO v_pkg, v_uom FROM public.goods_receipt_items
       WHERE goods_receipt_id = NEW.reference_id AND product_id = NEW.product_id
       ORDER BY (packaging_id IS NOT NULL) DESC, created_at ASC NULLS LAST LIMIT 1;
    WHEN 'stock_adjustment' THEN
      SELECT packaging_id, display_uom_id INTO v_pkg, v_uom FROM public.stock_adjustment_items
       WHERE adjustment_id = NEW.reference_id AND product_id = NEW.product_id
       ORDER BY (packaging_id IS NOT NULL) DESC, created_at ASC NULLS LAST LIMIT 1;
    WHEN 'stock_transfer' THEN
      SELECT packaging_id, display_uom_id INTO v_pkg, v_uom FROM public.stock_transfer_items
       WHERE transfer_id = NEW.reference_id AND product_id = NEW.product_id
       ORDER BY (packaging_id IS NOT NULL) DESC, created_at ASC NULLS LAST LIMIT 1;
    WHEN 'pos_transaction' THEN
      SELECT packaging_id, display_uom_id INTO v_pkg, v_uom FROM public.pos_transaction_items
       WHERE transaction_id = NEW.reference_id AND product_id = NEW.product_id
       ORDER BY (packaging_id IS NOT NULL) DESC, created_at ASC NULLS LAST LIMIT 1;
    WHEN 'sales_return' THEN
      SELECT packaging_id, display_uom_id INTO v_pkg, v_uom FROM public.sales_return_items
       WHERE return_id = NEW.reference_id AND product_id = NEW.product_id
       ORDER BY (packaging_id IS NOT NULL) DESC, created_at ASC NULLS LAST LIMIT 1;
    WHEN 'purchase_return' THEN
      SELECT packaging_id, display_uom_id INTO v_pkg, v_uom FROM public.purchase_return_items
       WHERE return_id = NEW.reference_id AND product_id = NEW.product_id
       ORDER BY (packaging_id IS NOT NULL) DESC, created_at ASC NULLS LAST LIMIT 1;
    WHEN 'credit_note' THEN
      SELECT packaging_id, display_uom_id INTO v_pkg, v_uom FROM public.credit_note_items
       WHERE credit_note_id = NEW.reference_id AND product_id = NEW.product_id
       ORDER BY (packaging_id IS NOT NULL) DESC, created_at ASC NULLS LAST LIMIT 1;
    WHEN 'bill' THEN
      SELECT packaging_id, display_uom_id INTO v_pkg, v_uom FROM public.bill_items
       WHERE bill_id = NEW.reference_id AND product_id = NEW.product_id
       ORDER BY (packaging_id IS NOT NULL) DESC, created_at ASC NULLS LAST LIMIT 1;
    ELSE
      RETURN NEW;
  END CASE;

  IF v_pkg IS NULL AND v_uom IS NULL THEN RETURN NEW; END IF;

  UPDATE public.stock_movements
     SET source_packaging_id = COALESCE(source_packaging_id, v_pkg),
         source_uom_id       = COALESCE(source_uom_id, v_uom)
   WHERE id = NEW.id
     AND (source_packaging_id IS NULL OR source_uom_id IS NULL);
  RETURN NEW;
END; $function$;

-- 3. Backfill uom_snapshot on existing POS lines that picked a pack.
WITH src AS (
  SELECT pti.id,
         CASE WHEN pp.qty_in_base_uom IS NULL OR pp.qty_in_base_uom <= 1 THEN pp.name
              ELSE pp.name || ' × ' || pp.qty_in_base_uom::text || ' '
                   || COALESCE(uom.code, uom.name, 'ea')
         END AS snap
    FROM public.pos_transaction_items pti
    JOIN public.product_packaging pp ON pp.id = pti.packaging_id
    LEFT JOIN public.products p ON p.id = pti.product_id
    LEFT JOIN public.units_of_measure uom ON uom.id = p.base_uom_id
   WHERE pti.packaging_id IS NOT NULL
     AND (pti.uom_snapshot IS NULL OR pti.uom_snapshot = '')
)
UPDATE public.pos_transaction_items pti
   SET uom_snapshot = src.snap FROM src WHERE pti.id = src.id;

-- 4. Retro-stamp existing stock_movements.
WITH src AS (
  SELECT 'pos_transaction'::text rt, pti.transaction_id ref_id, pti.product_id,
         pti.packaging_id, pti.display_uom_id
    FROM public.pos_transaction_items pti
   WHERE pti.packaging_id IS NOT NULL OR pti.display_uom_id IS NOT NULL
  UNION ALL
  SELECT 'invoice', ii.invoice_id, ii.product_id, ii.packaging_id, ii.display_uom_id
    FROM public.invoice_items ii
   WHERE ii.packaging_id IS NOT NULL OR ii.display_uom_id IS NOT NULL
  UNION ALL
  SELECT 'delivery_note', dni.delivery_note_id, dni.product_id, dni.packaging_id, dni.display_uom_id
    FROM public.delivery_note_items dni
   WHERE dni.packaging_id IS NOT NULL OR dni.display_uom_id IS NOT NULL
  UNION ALL
  SELECT 'goods_receipt', gri.goods_receipt_id, gri.product_id, gri.packaging_id, gri.display_uom_id
    FROM public.goods_receipt_items gri
   WHERE gri.packaging_id IS NOT NULL OR gri.display_uom_id IS NOT NULL
)
UPDATE public.stock_movements sm
   SET source_packaging_id = COALESCE(sm.source_packaging_id, src.packaging_id),
       source_uom_id       = COALESCE(sm.source_uom_id, src.display_uom_id)
  FROM src
 WHERE sm.reference_type = src.rt
   AND sm.reference_id   = src.ref_id
   AND sm.product_id     = src.product_id
   AND (sm.source_packaging_id IS NULL OR sm.source_uom_id IS NULL);
