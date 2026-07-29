
ALTER TABLE public.wms_crossdock_opportunities
  ALTER COLUMN grn_line_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS receiving_line_id uuid
    REFERENCES public.wms_receiving_lines(id) ON DELETE CASCADE;

ALTER TABLE public.wms_crossdock_opportunities
  DROP CONSTRAINT IF EXISTS wms_crossdock_source_present;
ALTER TABLE public.wms_crossdock_opportunities
  ADD CONSTRAINT wms_crossdock_source_present
  CHECK (grn_line_id IS NOT NULL OR receiving_line_id IS NOT NULL);

ALTER TABLE public.wms_crossdock_opportunities
  DROP CONSTRAINT IF EXISTS wms_crossdock_grn_line_unique;
CREATE UNIQUE INDEX IF NOT EXISTS wms_crossdock_grn_line_unique
  ON public.wms_crossdock_opportunities (business_id, grn_line_id)
  WHERE grn_line_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS wms_crossdock_receiving_line_unique
  ON public.wms_crossdock_opportunities (business_id, receiving_line_id)
  WHERE receiving_line_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.evaluate_crossdock_on_receiving_line(p_line_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_line  public.wms_receiving_lines;
  v_wh    public.warehouses;
  v_biz   uuid;
  v_soi   record;
  v_row   public.wms_crossdock_opportunities;
BEGIN
  SELECT * INTO v_line FROM public.wms_receiving_lines WHERE id = p_line_id;
  IF NOT FOUND THEN RETURN 0; END IF;
  IF COALESCE(v_line.received_qty, 0) <= 0 OR v_line.product_id IS NULL THEN RETURN 0; END IF;

  SELECT * INTO v_wh FROM public.warehouses WHERE id = v_line.warehouse_id;
  IF NOT FOUND THEN RETURN 0; END IF;
  v_biz := v_wh.business_id;

  IF EXISTS (
    SELECT 1 FROM public.wms_crossdock_opportunities
     WHERE business_id = v_biz AND receiving_line_id = p_line_id
  ) THEN
    RETURN 0;
  END IF;

  SELECT soi.id AS soi_id, so.id AS so_id, so.branch_id AS so_branch
    INTO v_soi
    FROM public.sales_order_items soi
    JOIN public.sales_orders so ON so.id = soi.sales_order_id
   WHERE so.business_id = v_biz
     AND soi.product_id = v_line.product_id
     AND so.status IN ('confirmed','processing','partial')
     AND (COALESCE(soi.quantity, 0) - COALESCE(soi.quantity_fulfilled, 0)) > 0
   ORDER BY so.order_date ASC, so.created_at ASC
   LIMIT 1;
  IF NOT FOUND THEN RETURN 0; END IF;

  INSERT INTO public.wms_crossdock_opportunities (
    business_id, organization_id, branch_id, warehouse_id,
    receiving_line_id, product_id, quantity,
    sales_order_id, sales_order_item_id, status
  ) VALUES (
    v_biz, v_wh.organization_id, COALESCE(v_wh.branch_id, v_soi.so_branch), v_line.warehouse_id,
    p_line_id, v_line.product_id, v_line.received_qty,
    v_soi.so_id, v_soi.soi_id, 'open'
  )
  ON CONFLICT DO NOTHING
  RETURNING * INTO v_row;

  IF v_row.id IS NOT NULL THEN
    PERFORM public.emit_crossdock_event('warehouse.crossdock.matched', v_row);
    RETURN 1;
  END IF;
  RETURN 0;
END $$;

GRANT EXECUTE ON FUNCTION public.evaluate_crossdock_on_receiving_line(uuid) TO authenticated, service_role;
