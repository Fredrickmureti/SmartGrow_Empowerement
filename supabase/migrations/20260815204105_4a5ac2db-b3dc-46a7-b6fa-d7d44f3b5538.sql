-- ============================================================
-- Purchases Phase 1 — one quantity conversion engine
-- ============================================================

-- 1. RFQ + requisition lines gain the purchasing-unit contract ---------------
ALTER TABLE public.rfq_items
  ADD COLUMN IF NOT EXISTS packaging_id uuid REFERENCES public.product_packaging(id),
  ADD COLUMN IF NOT EXISTS display_quantity numeric,
  ADD COLUMN IF NOT EXISTS display_uom_id uuid REFERENCES public.units_of_measure(id),
  ADD COLUMN IF NOT EXISTS uom_snapshot text,
  ADD COLUMN IF NOT EXISTS uom_snapshot_pack_name text,
  ADD COLUMN IF NOT EXISTS uom_snapshot_factor numeric,
  ADD COLUMN IF NOT EXISTS uom_snapshot_base_code text;

ALTER TABLE public.purchase_requisition_items
  ADD COLUMN IF NOT EXISTS packaging_id uuid REFERENCES public.product_packaging(id),
  ADD COLUMN IF NOT EXISTS display_quantity numeric,
  ADD COLUMN IF NOT EXISTS display_uom_id uuid REFERENCES public.units_of_measure(id),
  ADD COLUMN IF NOT EXISTS uom_snapshot text,
  ADD COLUMN IF NOT EXISTS uom_snapshot_pack_name text,
  ADD COLUMN IF NOT EXISTS uom_snapshot_factor numeric,
  ADD COLUMN IF NOT EXISTS uom_snapshot_base_code text;

UPDATE public.rfq_items
   SET display_quantity = COALESCE(display_quantity, quantity),
       display_uom_id   = COALESCE(display_uom_id, uom_id)
 WHERE display_quantity IS NULL OR display_uom_id IS NULL;

UPDATE public.purchase_requisition_items
   SET display_quantity = COALESCE(display_quantity, quantity),
       display_uom_id   = COALESCE(display_uom_id, uom_id)
 WHERE display_quantity IS NULL OR display_uom_id IS NULL;

COMMENT ON COLUMN public.rfq_items.display_quantity IS
  'Supplier-facing quantity as entered (e.g. 10 bags). quantity stays canonical base units.';
COMMENT ON COLUMN public.purchase_requisition_items.display_quantity IS
  'Requested quantity as entered (e.g. 10 bags). quantity stays canonical base units.';

-- 2. ONE normalizer for every purchasing / stock document line --------------
CREATE OR REPLACE FUNCTION public._uom_normalize_line()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_base_uom   uuid;
  v_qty_col    text;
  v_row        jsonb := to_jsonb(NEW);
  v_old        jsonb;
  v_renorm     boolean;
  v_display    numeric;
  v_base_qty   numeric;
  v_res        jsonb;
  v_patch      jsonb := '{}'::jsonb;
  v_product    uuid;
  v_pack       uuid;
  v_duom       uuid;
  v_label      text;
BEGIN
  v_product := nullif(v_row->>'product_id','')::uuid;
  IF v_product IS NULL THEN RETURN NEW; END IF;

  SELECT base_uom_id INTO v_base_uom FROM public.products WHERE id = v_product;
  IF v_base_uom IS NULL THEN RETURN NEW; END IF;

  v_qty_col := CASE TG_TABLE_NAME
    WHEN 'delivery_note_items' THEN 'quantity_delivered'
    WHEN 'goods_receipt_items' THEN 'quantity_received'
    WHEN 'stock_transfer_items' THEN 'quantity_sent'
    ELSE 'quantity'
  END;
  IF NOT (v_row ? v_qty_col) THEN RETURN NEW; END IF;

  v_pack    := nullif(v_row->>'packaging_id','')::uuid;
  v_duom    := nullif(v_row->>'display_uom_id','')::uuid;
  v_display := nullif(v_row->>'display_quantity','')::numeric;
  v_base_qty:= nullif(v_row->>v_qty_col,'')::numeric;

  IF TG_OP = 'UPDATE' THEN
    v_old := to_jsonb(OLD);
    v_renorm := (v_row->>'packaging_id')     IS DISTINCT FROM (v_old->>'packaging_id')
             OR (v_row->>'display_quantity') IS DISTINCT FROM (v_old->>'display_quantity')
             OR (v_row->>'display_uom_id')   IS DISTINCT FROM (v_old->>'display_uom_id');
  ELSE
    v_renorm := true;
  END IF;

  IF NOT v_renorm THEN
    IF v_duom IS NULL THEN
      v_patch := v_patch || jsonb_build_object('display_uom_id', v_base_uom);
    END IF;
    IF v_display IS NULL THEN
      v_patch := v_patch || jsonb_build_object('display_quantity', v_base_qty);
    END IF;
    IF v_patch <> '{}'::jsonb THEN
      NEW := jsonb_populate_record(NEW, to_jsonb(NEW) || v_patch);
    END IF;
    RETURN NEW;
  END IF;

  -- Derive the entered quantity when the caller only supplied base units.
  IF v_display IS NULL THEN
    IF v_pack IS NOT NULL THEN
      SELECT v_base_qty / NULLIF(pk.qty_in_base_uom, 0)
        INTO v_display
        FROM public.product_packaging pk
       WHERE pk.id = v_pack;
    END IF;
    v_display := COALESCE(v_display, v_base_qty);
  END IF;
  IF v_display IS NULL THEN RETURN NEW; END IF;

  -- Single canonical conversion. The browser never authors the base quantity.
  v_res := public.resolve_line_base_quantity(NULL, v_product, v_display, v_duom, v_pack);

  v_patch := jsonb_build_object(
    v_qty_col,          (v_res->>'base_quantity')::numeric,
    'display_quantity', v_display,
    'display_uom_id',   COALESCE((v_res->>'display_uom_id')::uuid, v_base_uom)
  );

  v_label := v_res->>'uom_snapshot';
  IF v_label IS NOT NULL AND (v_row ? 'uom_snapshot')
     AND COALESCE(v_row->>'uom_snapshot','') = '' THEN
    v_patch := v_patch || jsonb_build_object('uom_snapshot', v_label);
  END IF;

  NEW := jsonb_populate_record(NEW, to_jsonb(NEW) || v_patch);
  RETURN NEW;
END;
$function$;

-- 3. Goods receipts stop using their private copy of the arithmetic ---------
DROP TRIGGER IF EXISTS trg_uom_normalize_grn_items ON public.goods_receipt_items;
DROP FUNCTION IF EXISTS public._uom_normalize_line_grn();

-- 4. Attach the single normalizer everywhere purchasing lines are written.
--    Names start with 'a_' so normalization runs before the alphabetically
--    later consistency validator (`enforce_line_uom_consistency`).
DROP TRIGGER IF EXISTS a_uom_normalize_grn_items ON public.goods_receipt_items;
CREATE TRIGGER a_uom_normalize_grn_items
  BEFORE INSERT OR UPDATE ON public.goods_receipt_items
  FOR EACH ROW EXECUTE FUNCTION public._uom_normalize_line();

DROP TRIGGER IF EXISTS a_uom_normalize_bill_items ON public.bill_items;
CREATE TRIGGER a_uom_normalize_bill_items
  BEFORE INSERT OR UPDATE ON public.bill_items
  FOR EACH ROW EXECUTE FUNCTION public._uom_normalize_line();

DROP TRIGGER IF EXISTS a_uom_normalize_purchase_return_items ON public.purchase_return_items;
CREATE TRIGGER a_uom_normalize_purchase_return_items
  BEFORE INSERT OR UPDATE ON public.purchase_return_items
  FOR EACH ROW EXECUTE FUNCTION public._uom_normalize_line();

DROP TRIGGER IF EXISTS a_uom_normalize_rfq_items ON public.rfq_items;
CREATE TRIGGER a_uom_normalize_rfq_items
  BEFORE INSERT OR UPDATE ON public.rfq_items
  FOR EACH ROW EXECUTE FUNCTION public._uom_normalize_line();

DROP TRIGGER IF EXISTS a_uom_normalize_requisition_items ON public.purchase_requisition_items;
CREATE TRIGGER a_uom_normalize_requisition_items
  BEFORE INSERT OR UPDATE ON public.purchase_requisition_items
  FOR EACH ROW EXECUTE FUNCTION public._uom_normalize_line();

-- 5. Frozen snapshot stamping + packaging/UoM coherence on the two new tables
DROP TRIGGER IF EXISTS enforce_line_uom_consistency ON public.rfq_items;
CREATE TRIGGER enforce_line_uom_consistency
  BEFORE INSERT OR UPDATE ON public.rfq_items
  FOR EACH ROW EXECUTE FUNCTION public.enforce_line_uom_consistency();

DROP TRIGGER IF EXISTS enforce_line_uom_consistency ON public.purchase_requisition_items;
CREATE TRIGGER enforce_line_uom_consistency
  BEFORE INSERT OR UPDATE ON public.purchase_requisition_items
  FOR EACH ROW EXECUTE FUNCTION public.enforce_line_uom_consistency();
