
-- 1. Lineage table -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.cost_layer_lineage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  child_layer_id uuid NOT NULL REFERENCES public.cost_layers(id) ON DELETE CASCADE,
  parent_layer_id uuid NOT NULL REFERENCES public.cost_layers(id) ON DELETE CASCADE,
  consumption_id uuid REFERENCES public.cost_layer_consumptions(id) ON DELETE SET NULL,
  movement_id uuid,
  qty numeric NOT NULL CHECK (qty > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cost_layer_lineage_parent ON public.cost_layer_lineage(parent_layer_id);
CREATE INDEX IF NOT EXISTS idx_cost_layer_lineage_child ON public.cost_layer_lineage(child_layer_id);
CREATE INDEX IF NOT EXISTS idx_cost_layer_lineage_consumption ON public.cost_layer_lineage(consumption_id);

GRANT SELECT ON public.cost_layer_lineage TO authenticated;
GRANT ALL ON public.cost_layer_lineage TO service_role;

ALTER TABLE public.cost_layer_lineage ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Org members read cost layer lineage" ON public.cost_layer_lineage;
CREATE POLICY "Org members read cost layer lineage"
  ON public.cost_layer_lineage FOR SELECT TO authenticated
  USING (public.is_org_member(auth.uid(), organization_id));

-- 2. Record lineage on inbound transfer movements -----------------------------
CREATE OR REPLACE FUNCTION public._maintain_cost_layers()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_remaining numeric; v_take numeric; v_layer RECORD; v_qty_abs numeric;
  v_child uuid; v_cons RECORD;
BEGIN
  v_qty_abs := abs(NEW.quantity);
  IF v_qty_abs = 0 OR NEW.product_id IS NULL THEN RETURN NEW; END IF;

  IF NEW.movement_type::text IN ('receipt','adjustment_in','transfer_in','opening_stock','return_in','customer_return')
     OR (NEW.movement_type::text = 'adjustment' AND NEW.quantity > 0) THEN
    INSERT INTO public.cost_layers (
      organization_id, business_id, warehouse_id, product_id,
      source_movement_id, received_at, qty_total, qty_remaining,
      unit_cost, source_uom_id, lot_number, serial_number
    ) VALUES (
      NEW.organization_id, NEW.business_id, NEW.warehouse_id, NEW.product_id,
      NEW.id, COALESCE(NEW.movement_date, NEW.created_at, now()),
      v_qty_abs, v_qty_abs, COALESCE(NEW.unit_cost, 0), NEW.source_uom_id,
      NEW.lot_number, NEW.serial_number
    )
    RETURNING id INTO v_child;

    -- Layer lineage: an inbound transfer leg inherits from the outbound leg's
    -- consumed layers, so valuation adjustments can follow stock across
    -- warehouses (source -> in-transit -> destination).
    IF NEW.reference_type = 'stock_transfer' AND NEW.reference_id IS NOT NULL THEN
      v_remaining := v_qty_abs;
      FOR v_cons IN
        SELECT c.id, c.layer_id,
               c.qty_consumed - COALESCE((
                 SELECT SUM(l.qty) FROM public.cost_layer_lineage l
                  WHERE l.consumption_id = c.id), 0) AS qty_free
          FROM public.cost_layer_consumptions c
          JOIN public.stock_movements m ON m.id = c.movement_id
         WHERE m.reference_type = 'stock_transfer'
           AND m.reference_id = NEW.reference_id
           AND c.product_id = NEW.product_id
           AND c.business_id = NEW.business_id
           AND (NEW.lot_number IS NULL OR m.lot_number IS NOT DISTINCT FROM NEW.lot_number)
         ORDER BY c.consumed_at, c.id
      LOOP
        EXIT WHEN v_remaining <= 0;
        IF v_cons.qty_free IS NULL OR v_cons.qty_free <= 0 THEN CONTINUE; END IF;
        v_take := LEAST(v_cons.qty_free, v_remaining);
        INSERT INTO public.cost_layer_lineage (
          organization_id, business_id, child_layer_id, parent_layer_id,
          consumption_id, movement_id, qty
        ) VALUES (
          NEW.organization_id, NEW.business_id, v_child, v_cons.layer_id,
          v_cons.id, NEW.id, v_take
        );
        v_remaining := v_remaining - v_take;
      END LOOP;
    END IF;

    RETURN NEW;
  END IF;

  IF NEW.movement_type::text IN ('sale','delivery','pos_sale','transfer_out','scrap','adjustment_out','return_out','vendor_return')
     OR (NEW.movement_type::text = 'adjustment' AND NEW.quantity < 0) THEN
    v_remaining := v_qty_abs;
    FOR v_layer IN
      SELECT id, qty_remaining, unit_cost FROM public.cost_layers
       WHERE business_id = NEW.business_id AND product_id = NEW.product_id
         AND (NEW.warehouse_id IS NULL OR warehouse_id IS NULL OR warehouse_id = NEW.warehouse_id)
         AND qty_remaining > 0
       ORDER BY received_at, created_at FOR UPDATE
    LOOP
      EXIT WHEN v_remaining <= 0;
      v_take := LEAST(v_layer.qty_remaining, v_remaining);
      UPDATE public.cost_layers SET qty_remaining = qty_remaining - v_take WHERE id = v_layer.id;
      INSERT INTO public.cost_layer_consumptions (
        organization_id, business_id, layer_id, movement_id, product_id, qty_consumed, unit_cost
      ) VALUES (
        NEW.organization_id, NEW.business_id, v_layer.id, NEW.id, NEW.product_id, v_take, v_layer.unit_cost
      );
      v_remaining := v_remaining - v_take;
    END LOOP;
  END IF;

  RETURN NEW;
END; $function$;

-- 3. Descendant tracing -------------------------------------------------------
CREATE OR REPLACE FUNCTION public.inventory_cost_layer_descendants(p_layer_ids uuid[])
 RETURNS TABLE(layer_id uuid, traced_qty numeric)
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH RECURSIVE d AS (
    SELECT l.child_layer_id AS layer_id, l.qty
      FROM public.cost_layer_lineage l
     WHERE l.parent_layer_id = ANY(p_layer_ids)
    UNION ALL
    SELECT l.child_layer_id, LEAST(l.qty, d.qty)
      FROM public.cost_layer_lineage l
      JOIN d ON l.parent_layer_id = d.layer_id
  )
  SELECT d.layer_id,
         LEAST(SUM(d.qty), cl.qty_remaining) AS traced_qty
    FROM d
    JOIN public.cost_layers cl ON cl.id = d.layer_id
   WHERE cl.qty_remaining > 0
   GROUP BY d.layer_id, cl.qty_remaining
  HAVING LEAST(SUM(d.qty), cl.qty_remaining) > 0;
$function$;

REVOKE ALL ON FUNCTION public.inventory_cost_layer_descendants(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.inventory_cost_layer_descendants(uuid[]) TO authenticated, service_role;

-- 4. Capitalise across transferred stock --------------------------------------
CREATE OR REPLACE FUNCTION public.inventory_apply_cost_revaluation(
  p_goods_receipt_item_id uuid, p_amount numeric, p_source_type text,
  p_source_id uuid, p_actor uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_gri RECORD;
  v_qty_total numeric := 0;
  v_qty_remaining numeric := 0;
  v_capitalized numeric := 0;
  v_expensed numeric := 0;
  v_layer RECORD;
  v_share numeric;
  v_running numeric := 0;
  v_layers integer := 0;
  v_transferred numeric := 0;
  v_before numeric;
  v_after numeric;
  v_last_reval uuid;
BEGIN
  IF p_amount IS NULL OR p_amount = 0 THEN
    RETURN jsonb_build_object('capitalized', 0, 'expensed', 0, 'layers', 0);
  END IF;

  SELECT gri.id, gri.product_id, gr.id AS grn_id, gr.warehouse_id,
         gr.organization_id, gr.business_id
    INTO v_gri
    FROM public.goods_receipt_items gri
    JOIN public.goods_receipts gr ON gr.id = gri.goods_receipt_id
   WHERE gri.id = p_goods_receipt_item_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'goods_receipt_item % not found', p_goods_receipt_item_id
      USING ERRCODE = 'P0002';
  END IF;

  IF v_gri.product_id IS NULL THEN
    RAISE EXCEPTION 'receipt line % has no product — not valuation eligible', p_goods_receipt_item_id
      USING ERRCODE = 'P0001';
  END IF;

  -- Layers created by this receipt for this product/warehouse (the origin set).
  CREATE TEMP TABLE tmp_reval_origin ON COMMIT DROP AS
  SELECT cl.id, cl.qty_total, cl.qty_remaining
    FROM public.cost_layers cl
    JOIN public.stock_movements sm ON sm.id = cl.source_movement_id
   WHERE cl.business_id = v_gri.business_id
     AND cl.product_id = v_gri.product_id
     AND sm.reference_type = 'goods_receipt'
     AND sm.reference_id = v_gri.grn_id
     AND (v_gri.warehouse_id IS NULL OR cl.warehouse_id IS NOT DISTINCT FROM v_gri.warehouse_id);

  SELECT COALESCE(SUM(qty_total), 0) INTO v_qty_total FROM tmp_reval_origin;

  IF v_qty_total <= 0 THEN
    RETURN jsonb_build_object(
      'capitalized', 0, 'expensed', ROUND(p_amount, 2), 'layers', 0,
      'reason', 'no_cost_layer'
    );
  END IF;

  -- Eligible set = origin layers still on hand + their transfer descendants,
  -- so stock moved to another warehouse before posting is still capitalised.
  CREATE TEMP TABLE tmp_reval_layers ON COMMIT DROP AS
  SELECT o.id, cl.warehouse_id, cl.qty_remaining, o.qty_remaining AS eligible_qty, false AS transferred
    FROM tmp_reval_origin o
    JOIN public.cost_layers cl ON cl.id = o.id
   WHERE o.qty_remaining > 0
  UNION ALL
  SELECT d.layer_id, cl.warehouse_id, cl.qty_remaining, d.traced_qty, true
    FROM public.inventory_cost_layer_descendants(
           ARRAY(SELECT id FROM tmp_reval_origin)) d
    JOIN public.cost_layers cl ON cl.id = d.layer_id;

  SELECT COALESCE(SUM(eligible_qty), 0),
         COALESCE(SUM(eligible_qty) FILTER (WHERE transferred), 0)
    INTO v_qty_remaining, v_transferred
    FROM tmp_reval_layers;

  -- Never capitalise more than the receipt quantity.
  IF v_qty_remaining > v_qty_total THEN
    v_qty_remaining := v_qty_total;
  END IF;

  v_capitalized := ROUND(p_amount * v_qty_remaining / v_qty_total, 2);
  v_expensed := ROUND(p_amount, 2) - v_capitalized;

  IF v_capitalized <> 0 AND v_qty_remaining > 0 THEN
    FOR v_layer IN
      SELECT * FROM tmp_reval_layers WHERE eligible_qty > 0 ORDER BY transferred, id
    LOOP
      v_layers := v_layers + 1;
      v_share := ROUND(v_capitalized * v_layer.eligible_qty / NULLIF(
                   (SELECT SUM(eligible_qty) FROM tmp_reval_layers WHERE eligible_qty > 0), 0), 2);
      v_running := v_running + v_share;

      SELECT unit_cost INTO v_before FROM public.cost_layers WHERE id = v_layer.id FOR UPDATE;
      v_after := v_before + (v_share / v_layer.qty_remaining);

      UPDATE public.cost_layers SET unit_cost = v_after WHERE id = v_layer.id;

      INSERT INTO public.inventory_cost_revaluations (
        organization_id, business_id, layer_id, product_id, warehouse_id,
        source_type, source_id, source_line_id,
        qty_remaining_at_apply, amount_applied,
        unit_cost_before, unit_cost_after, created_by
      ) VALUES (
        v_gri.organization_id, v_gri.business_id, v_layer.id, v_gri.product_id,
        COALESCE(v_layer.warehouse_id, v_gri.warehouse_id),
        p_source_type, p_source_id, p_goods_receipt_item_id,
        v_layer.qty_remaining, v_share,
        v_before, v_after, COALESCE(p_actor, auth.uid())
      );
    END LOOP;

    -- Absorb rounding drift on the last touched layer.
    IF v_running <> v_capitalized THEN
      SELECT id INTO v_last_reval
        FROM public.inventory_cost_revaluations
       WHERE source_type = p_source_type AND source_id = p_source_id
         AND source_line_id = p_goods_receipt_item_id AND reversed_at IS NULL
       ORDER BY created_at DESC, id DESC LIMIT 1;

      UPDATE public.inventory_cost_revaluations
         SET amount_applied = amount_applied + (v_capitalized - v_running)
       WHERE id = v_last_reval;
    END IF;
  END IF;

  DROP TABLE IF EXISTS tmp_reval_origin;
  DROP TABLE IF EXISTS tmp_reval_layers;

  RETURN jsonb_build_object(
    'capitalized', v_capitalized,
    'expensed', v_expensed,
    'layers', v_layers,
    'qty_total', v_qty_total,
    'qty_remaining', v_qty_remaining,
    'transferred_qty', v_transferred
  );
END;
$function$;
