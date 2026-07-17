
-- =====================================================================
-- WMS Phase 12 — Cross-dock & cartonization
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) wms_carton_types — master data (biz-scoped)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.wms_carton_types (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id      uuid NOT NULL,
  code             text NOT NULL,
  name             text NOT NULL,
  length_cm        numeric NOT NULL CHECK (length_cm  > 0),
  width_cm         numeric NOT NULL CHECK (width_cm   > 0),
  height_cm        numeric NOT NULL CHECK (height_cm  > 0),
  max_weight_kg    numeric NOT NULL DEFAULT 30 CHECK (max_weight_kg > 0),
  tare_weight_kg   numeric NOT NULL DEFAULT 0  CHECK (tare_weight_kg >= 0),
  cost             numeric(15,4) NOT NULL DEFAULT 0 CHECK (cost >= 0),
  is_active        boolean NOT NULL DEFAULT true,
  notes            text,
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wms_carton_types_unique_code UNIQUE (business_id, code)
);

CREATE INDEX IF NOT EXISTS idx_wms_carton_types_active
  ON public.wms_carton_types (business_id, is_active);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.wms_carton_types TO authenticated;
GRANT ALL ON public.wms_carton_types TO service_role;

ALTER TABLE public.wms_carton_types ENABLE ROW LEVEL SECURITY;

CREATE POLICY "wms_carton_types_select" ON public.wms_carton_types
  FOR SELECT TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id));

CREATE POLICY "wms_carton_types_write" ON public.wms_carton_types
  FOR ALL TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id)
         AND public.user_has_module_permission(auth.uid(), business_id, 'inventory', 'write'))
  WITH CHECK (public.user_can_access_business(auth.uid(), business_id)
              AND public.user_has_module_permission(auth.uid(), business_id, 'inventory', 'write'));

CREATE OR REPLACE FUNCTION public._touch_wms_carton_types_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS trg_wms_carton_types_updated_at ON public.wms_carton_types;
CREATE TRIGGER trg_wms_carton_types_updated_at
  BEFORE UPDATE ON public.wms_carton_types
  FOR EACH ROW EXECUTE FUNCTION public._touch_wms_carton_types_updated_at();

-- ---------------------------------------------------------------------
-- 2) wms_crossdock_opportunities — RPC-only ledger
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.wms_crossdock_opportunities (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id            uuid NOT NULL,
  organization_id        uuid NOT NULL,
  branch_id              uuid NULL,
  warehouse_id           uuid NOT NULL,
  grn_id                 uuid NOT NULL REFERENCES public.goods_receipts(id) ON DELETE CASCADE,
  grn_line_id            uuid NOT NULL REFERENCES public.goods_receipt_items(id) ON DELETE CASCADE,
  product_id             uuid NOT NULL,
  quantity               numeric NOT NULL CHECK (quantity > 0),
  sales_order_id         uuid NULL REFERENCES public.sales_orders(id) ON DELETE SET NULL,
  sales_order_item_id    uuid NULL REFERENCES public.sales_order_items(id) ON DELETE SET NULL,
  status                 text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','staged','cancelled')),
  stage_task_id          uuid NULL REFERENCES public.wms_tasks(id) ON DELETE SET NULL,
  matched_at             timestamptz NOT NULL DEFAULT now(),
  staged_at              timestamptz NULL,
  cancelled_at           timestamptz NULL,
  cancel_reason          text NULL,
  created_by             uuid,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wms_crossdock_grn_line_unique UNIQUE (business_id, grn_line_id)
);

CREATE INDEX IF NOT EXISTS idx_wms_crossdock_open
  ON public.wms_crossdock_opportunities (business_id, warehouse_id, status)
  WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_wms_crossdock_so
  ON public.wms_crossdock_opportunities (sales_order_id);

GRANT SELECT ON public.wms_crossdock_opportunities TO authenticated;
GRANT ALL ON public.wms_crossdock_opportunities TO service_role;

ALTER TABLE public.wms_crossdock_opportunities ENABLE ROW LEVEL SECURITY;

CREATE POLICY "wms_crossdock_select" ON public.wms_crossdock_opportunities
  FOR SELECT TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id));

-- No write policies — RPC-only.

CREATE OR REPLACE FUNCTION public._touch_wms_crossdock_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS trg_wms_crossdock_updated_at ON public.wms_crossdock_opportunities;
CREATE TRIGGER trg_wms_crossdock_updated_at
  BEFORE UPDATE ON public.wms_crossdock_opportunities
  FOR EACH ROW EXECUTE FUNCTION public._touch_wms_crossdock_updated_at();

-- ---------------------------------------------------------------------
-- 3) wms_pack_cartons.carton_type_id
-- ---------------------------------------------------------------------
ALTER TABLE public.wms_pack_cartons
  ADD COLUMN IF NOT EXISTS carton_type_id uuid NULL
    REFERENCES public.wms_carton_types(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_wms_pack_cartons_carton_type
  ON public.wms_pack_cartons(carton_type_id);

-- ---------------------------------------------------------------------
-- 4) emit_crossdock_event helper
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.emit_crossdock_event(
  p_type text, p_row public.wms_crossdock_opportunities
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  BEGIN
    INSERT INTO public.business_event_outbox (
      event_type, organization_id, business_id, branch_id,
      source_doc_type, source_doc_id, payload, idempotency_key, status
    ) VALUES (
      p_type, p_row.organization_id, p_row.business_id, p_row.branch_id,
      'crossdock_opportunity', p_row.id,
      jsonb_build_object(
        'opportunity_id', p_row.id,
        'warehouse_id', p_row.warehouse_id,
        'grn_id', p_row.grn_id,
        'grn_line_id', p_row.grn_line_id,
        'product_id', p_row.product_id,
        'quantity', p_row.quantity,
        'sales_order_id', p_row.sales_order_id,
        'sales_order_item_id', p_row.sales_order_item_id,
        'status', p_row.status,
        'stage_task_id', p_row.stage_task_id
      ),
      'wms.crossdock_opportunity:' || p_row.id || ':' || p_row.status,
      'pending'
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'crossdock event emission failed: %', SQLERRM;
  END;
END; $$;

REVOKE ALL ON FUNCTION public.emit_crossdock_event(text, public.wms_crossdock_opportunities) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.emit_crossdock_event(text, public.wms_crossdock_opportunities) TO authenticated, service_role;

-- ---------------------------------------------------------------------
-- 5) RPC: evaluate_crossdock_on_grn
--     Scans completed GRN lines, matches unfulfilled sales-order items
--     FIFO by order_date, and inserts one open opportunity per match.
--     Idempotent by (business_id, grn_line_id).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.evaluate_crossdock_on_grn(p_grn_id uuid)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_grn   public.goods_receipts;
  v_biz   uuid;
  v_wh    public.warehouses;
  v_line  record;
  v_soi   record;
  v_row   public.wms_crossdock_opportunities;
  v_count int := 0;
BEGIN
  SELECT * INTO v_grn FROM public.goods_receipts WHERE id = p_grn_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'goods receipt not found'; END IF;
  IF v_grn.status <> 'completed' THEN RETURN 0; END IF;
  IF v_grn.warehouse_id IS NULL THEN RETURN 0; END IF;

  SELECT * INTO v_wh FROM public.warehouses WHERE id = v_grn.warehouse_id;
  IF NOT FOUND THEN RETURN 0; END IF;
  v_biz := v_wh.business_id;

  FOR v_line IN
    SELECT gri.*
      FROM public.goods_receipt_items gri
     WHERE gri.goods_receipt_id = p_grn_id
       AND gri.quantity_received > 0
       AND gri.product_id IS NOT NULL
       -- Skip lines already under QC hold
       AND (gri.qc_inspection_id IS NULL
            OR NOT EXISTS (
              SELECT 1 FROM public.wms_qc_inspections q
               WHERE q.id = gri.qc_inspection_id AND q.state = 'open'
            ))
       -- Skip lines already evaluated
       AND NOT EXISTS (
         SELECT 1 FROM public.wms_crossdock_opportunities x
          WHERE x.business_id = v_biz AND x.grn_line_id = gri.id
       )
  LOOP
    -- Pick oldest unfulfilled sales order line for this product/business
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

    IF NOT FOUND THEN CONTINUE; END IF;

    INSERT INTO public.wms_crossdock_opportunities (
      business_id, organization_id, branch_id, warehouse_id,
      grn_id, grn_line_id, product_id, quantity,
      sales_order_id, sales_order_item_id, status
    ) VALUES (
      v_biz, v_wh.organization_id, COALESCE(v_wh.branch_id, v_soi.so_branch), v_grn.warehouse_id,
      p_grn_id, v_line.id, v_line.product_id, v_line.quantity_received,
      v_soi.so_id, v_soi.soi_id, 'open'
    )
    ON CONFLICT (business_id, grn_line_id) DO NOTHING
    RETURNING * INTO v_row;

    IF v_row.id IS NOT NULL THEN
      PERFORM public.emit_crossdock_event('warehouse.crossdock.matched', v_row);
      v_count := v_count + 1;
    END IF;
  END LOOP;

  RETURN v_count;
END; $$;

REVOKE ALL ON FUNCTION public.evaluate_crossdock_on_grn(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.evaluate_crossdock_on_grn(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------
-- 6) Trigger: run evaluation after a GRN is marked completed
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._trg_wms_crossdock_on_grn_complete()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status = 'completed' AND (OLD.status IS DISTINCT FROM NEW.status) THEN
    BEGIN
      PERFORM public.evaluate_crossdock_on_grn(NEW.id);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'crossdock evaluation failed for GRN %: %', NEW.id, SQLERRM;
    END;
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_wms_crossdock_on_grn_complete ON public.goods_receipts;
CREATE TRIGGER trg_wms_crossdock_on_grn_complete
  AFTER UPDATE OF status ON public.goods_receipts
  FOR EACH ROW EXECUTE FUNCTION public._trg_wms_crossdock_on_grn_complete();

-- ---------------------------------------------------------------------
-- 7) RPC: confirm_crossdock_stage
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.confirm_crossdock_stage(p_opportunity_id uuid)
RETURNS public.wms_crossdock_opportunities
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_row public.wms_crossdock_opportunities;
BEGIN
  SELECT * INTO v_row FROM public.wms_crossdock_opportunities WHERE id = p_opportunity_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'opportunity not found'; END IF;
  IF NOT public.user_can_access_business(auth.uid(), v_row.business_id) THEN
    RAISE EXCEPTION 'access denied';
  END IF;
  IF v_row.status <> 'open' THEN
    RAISE EXCEPTION 'opportunity is % (must be open)', v_row.status;
  END IF;

  UPDATE public.wms_crossdock_opportunities
     SET status = 'staged', staged_at = now()
   WHERE id = p_opportunity_id
   RETURNING * INTO v_row;

  PERFORM public.emit_crossdock_event('warehouse.crossdock.staged', v_row);
  RETURN v_row;
END; $$;

REVOKE ALL ON FUNCTION public.confirm_crossdock_stage(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.confirm_crossdock_stage(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------
-- 8) RPC: cancel_crossdock_opportunity
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cancel_crossdock_opportunity(
  p_opportunity_id uuid,
  p_reason text DEFAULT NULL
)
RETURNS public.wms_crossdock_opportunities
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_row public.wms_crossdock_opportunities;
BEGIN
  SELECT * INTO v_row FROM public.wms_crossdock_opportunities WHERE id = p_opportunity_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'opportunity not found'; END IF;
  IF NOT public.user_can_access_business(auth.uid(), v_row.business_id) THEN
    RAISE EXCEPTION 'access denied';
  END IF;
  IF v_row.status <> 'open' THEN
    RAISE EXCEPTION 'opportunity is % (only open can be cancelled)', v_row.status;
  END IF;

  UPDATE public.wms_crossdock_opportunities
     SET status = 'cancelled', cancelled_at = now(), cancel_reason = p_reason
   WHERE id = p_opportunity_id
   RETURNING * INTO v_row;

  PERFORM public.emit_crossdock_event('warehouse.crossdock.cancelled', v_row);
  RETURN v_row;
END; $$;

REVOKE ALL ON FUNCTION public.cancel_crossdock_opportunity(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cancel_crossdock_opportunity(uuid, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------
-- 9) RPC: suggest_carton
--     Smallest active carton in the catalogue whose interior volume and
--     max weight cover the sum of product dims/weights.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.suggest_carton(
  p_business_id uuid,
  p_product_ids uuid[],
  p_quantities  numeric[]
)
RETURNS public.wms_carton_types
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_volume_cm3 numeric := 0;
  v_weight_kg  numeric := 0;
  v_row        public.wms_carton_types;
  i int;
  v_pid uuid;
  v_qty numeric;
  v_p   record;
BEGIN
  IF NOT public.user_can_access_business(auth.uid(), p_business_id) THEN
    RAISE EXCEPTION 'access denied';
  END IF;
  IF p_product_ids IS NULL OR array_length(p_product_ids,1) IS NULL THEN
    RETURN NULL;
  END IF;
  IF array_length(p_product_ids,1) <> array_length(p_quantities,1) THEN
    RAISE EXCEPTION 'product_ids and quantities length mismatch';
  END IF;

  FOR i IN 1 .. array_length(p_product_ids,1) LOOP
    v_pid := p_product_ids[i];
    v_qty := COALESCE(p_quantities[i], 1);
    SELECT length_cm, width_cm, height_cm, weight_kg
      INTO v_p FROM public.products WHERE id = v_pid;
    IF NOT FOUND THEN CONTINUE; END IF;
    IF v_p.length_cm IS NULL OR v_p.width_cm IS NULL OR v_p.height_cm IS NULL THEN
      -- Missing dims → cannot compute; bail out gracefully so pack UI
      -- can prompt for manual selection.
      RETURN NULL;
    END IF;
    v_volume_cm3 := v_volume_cm3 + (v_p.length_cm * v_p.width_cm * v_p.height_cm) * v_qty;
    v_weight_kg  := v_weight_kg  + COALESCE(v_p.weight_kg, 0) * v_qty;
  END LOOP;

  IF v_volume_cm3 <= 0 THEN RETURN NULL; END IF;

  SELECT *
    INTO v_row
    FROM public.wms_carton_types
   WHERE business_id = p_business_id
     AND is_active
     AND (length_cm * width_cm * height_cm) >= v_volume_cm3
     AND max_weight_kg >= v_weight_kg
   ORDER BY (length_cm * width_cm * height_cm) ASC
   LIMIT 1;

  RETURN v_row;
END; $$;

REVOKE ALL ON FUNCTION public.suggest_carton(uuid, uuid[], numeric[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.suggest_carton(uuid, uuid[], numeric[]) TO authenticated, service_role;

-- ---------------------------------------------------------------------
-- 10) RPC: assign_carton_to_pack
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assign_carton_to_pack(
  p_carton_id      uuid,
  p_carton_type_id uuid
)
RETURNS public.wms_pack_cartons
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_row  public.wms_pack_cartons;
  v_type public.wms_carton_types;
BEGIN
  SELECT * INTO v_row FROM public.wms_pack_cartons WHERE id = p_carton_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'pack carton not found'; END IF;
  IF NOT public.user_can_access_business(auth.uid(), v_row.business_id) THEN
    RAISE EXCEPTION 'access denied';
  END IF;
  SELECT * INTO v_type FROM public.wms_carton_types WHERE id = p_carton_type_id;
  IF NOT FOUND OR v_type.business_id <> v_row.business_id OR NOT v_type.is_active THEN
    RAISE EXCEPTION 'carton type not found or inactive';
  END IF;

  UPDATE public.wms_pack_cartons
     SET carton_type_id = p_carton_type_id,
         length_cm = v_type.length_cm,
         width_cm  = v_type.width_cm,
         height_cm = v_type.height_cm,
         weight_kg = COALESCE(weight_kg, 0) + v_type.tare_weight_kg,
         updated_at = now()
   WHERE id = p_carton_id
   RETURNING * INTO v_row;

  RETURN v_row;
END; $$;

REVOKE ALL ON FUNCTION public.assign_carton_to_pack(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assign_carton_to_pack(uuid, uuid) TO authenticated, service_role;
