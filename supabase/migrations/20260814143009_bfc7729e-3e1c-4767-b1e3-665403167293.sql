-- ADR 0142 Phase 5 — lots, serials & traceability closure.

-- 1. ONE DIRECTION AUTHORITY -------------------------------------------------
CREATE OR REPLACE FUNCTION public.stock_movement_signed_quantity(
  p_movement_type text, p_quantity numeric
) RETURNS numeric
LANGUAGE sql IMMUTABLE
SET search_path TO 'public'
AS $$
  SELECT CASE
    WHEN COALESCE(p_quantity, 0) < 0 THEN p_quantity
    WHEN lower(COALESCE(p_movement_type, '')) IN (
      'sale','sale_out','delivery','delivery_out','pos_sale','transfer_out',
      'scrap','adjustment_out','return_out','vendor_return','purchase_return',
      'issue','consumption','shipment','pick'
    ) THEN -COALESCE(p_quantity, 0)
    ELSE COALESCE(p_quantity, 0)
  END;
$$;

GRANT EXECUTE ON FUNCTION public.stock_movement_signed_quantity(text, numeric) TO authenticated, anon, service_role;

-- 2. PER-LOT BALANCES USE THE SAME DIRECTION AS THE QUANT LEDGER -------------
CREATE OR REPLACE FUNCTION public._maintain_warehouse_stock_lots()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_signed_delta numeric;
  v_is_out boolean;
  v_lot_id uuid;
  v_is_lot_tracked boolean;
BEGIN
  IF NEW.product_id IS NULL OR NEW.warehouse_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_signed_delta := public.stock_movement_signed_quantity(NEW.movement_type::text, NEW.quantity);
  IF v_signed_delta = 0 THEN RETURN NEW; END IF;
  v_is_out := v_signed_delta < 0;

  SELECT is_lot_tracked INTO v_is_lot_tracked FROM public.products WHERE id = NEW.product_id;

  IF NEW.lot_number IS NULL OR NEW.lot_number = '' THEN
    IF COALESCE(v_is_lot_tracked, false) AND v_is_out THEN
      RAISE EXCEPTION 'INVENTORY_LOT_REQUIRED: product % is lot-tracked but outbound movement % has no lot_number',
        NEW.product_id, NEW.id USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  SELECT id INTO v_lot_id FROM public.stock_lots
   WHERE business_id = NEW.business_id AND product_id = NEW.product_id
     AND lot_number = NEW.lot_number
     AND ((serial_number IS NULL AND NEW.serial_number IS NULL) OR serial_number = NEW.serial_number)
   LIMIT 1;

  IF v_lot_id IS NULL THEN
    IF v_is_out THEN
      RAISE EXCEPTION 'INVENTORY_UNKNOWN_LOT: lot % does not exist for product % — cannot consume',
        NEW.lot_number, NEW.product_id USING ERRCODE = 'no_data_found';
    END IF;
    INSERT INTO public.stock_lots (organization_id, business_id, product_id, lot_number, serial_number)
    VALUES (NEW.organization_id, NEW.business_id, NEW.product_id, NEW.lot_number, NEW.serial_number)
    ON CONFLICT (business_id, product_id, lot_number, serial_number) DO NOTHING
    RETURNING id INTO v_lot_id;
    IF v_lot_id IS NULL THEN
      SELECT id INTO v_lot_id FROM public.stock_lots
       WHERE business_id = NEW.business_id AND product_id = NEW.product_id
         AND lot_number = NEW.lot_number
         AND ((serial_number IS NULL AND NEW.serial_number IS NULL) OR serial_number = NEW.serial_number);
    END IF;
  END IF;

  INSERT INTO public.warehouse_stock_lots (
    organization_id, business_id, warehouse_id, product_id, lot_id, quantity
  ) VALUES (
    NEW.organization_id, NEW.business_id, NEW.warehouse_id, NEW.product_id, v_lot_id, v_signed_delta
  )
  ON CONFLICT (business_id, warehouse_id, product_id, lot_id)
  DO UPDATE SET quantity = public.warehouse_stock_lots.quantity + v_signed_delta;

  RETURN NEW;
END;
$function$;

-- 3. EXPIRY POLICY -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.stock_lot_expiry_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  category_id uuid NULL,
  outbound_enforcement text NOT NULL DEFAULT 'block'
    CHECK (outbound_enforcement IN ('block','warn','allow')),
  receipt_enforcement text NOT NULL DEFAULT 'warn'
    CHECK (receipt_enforcement IN ('block','warn','allow')),
  require_expiry_on_receipt boolean NOT NULL DEFAULT true,
  min_shelf_life_days integer NOT NULL DEFAULT 0 CHECK (min_shelf_life_days >= 0),
  is_active boolean NOT NULL DEFAULT true,
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS stock_lot_expiry_policies_scope_idx
  ON public.stock_lot_expiry_policies (business_id, COALESCE(category_id, '00000000-0000-0000-0000-000000000000'::uuid));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.stock_lot_expiry_policies TO authenticated;
GRANT ALL ON public.stock_lot_expiry_policies TO service_role;

ALTER TABLE public.stock_lot_expiry_policies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members read lot expiry policies" ON public.stock_lot_expiry_policies;
CREATE POLICY "Members read lot expiry policies" ON public.stock_lot_expiry_policies
  FOR SELECT TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id));

DROP POLICY IF EXISTS "Members manage lot expiry policies" ON public.stock_lot_expiry_policies;
CREATE POLICY "Members manage lot expiry policies" ON public.stock_lot_expiry_policies
  FOR ALL TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id))
  WITH CHECK (public.user_can_access_business(auth.uid(), business_id));

DROP TRIGGER IF EXISTS trg_stock_lot_expiry_policies_updated_at ON public.stock_lot_expiry_policies;
CREATE TRIGGER trg_stock_lot_expiry_policies_updated_at
  BEFORE UPDATE ON public.stock_lot_expiry_policies
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE OR REPLACE FUNCTION public.resolve_lot_expiry_policy(
  p_business_id uuid, p_product_id uuid
) RETURNS public.stock_lot_expiry_policies
LANGUAGE plpgsql STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_category uuid;
  v_policy public.stock_lot_expiry_policies;
BEGIN
  SELECT category_id INTO v_category FROM public.products WHERE id = p_product_id;

  SELECT * INTO v_policy FROM public.stock_lot_expiry_policies
   WHERE business_id = p_business_id AND is_active
     AND category_id IS NOT DISTINCT FROM v_category
   LIMIT 1;

  IF v_policy.id IS NULL THEN
    SELECT * INTO v_policy FROM public.stock_lot_expiry_policies
     WHERE business_id = p_business_id AND is_active AND category_id IS NULL
     LIMIT 1;
  END IF;

  IF v_policy.id IS NULL THEN
    v_policy.business_id := p_business_id;
    v_policy.outbound_enforcement := 'block';
    v_policy.receipt_enforcement := 'warn';
    v_policy.require_expiry_on_receipt := true;
    v_policy.min_shelf_life_days := 0;
    v_policy.is_active := true;
  END IF;

  RETURN v_policy;
END;
$$;

GRANT EXECUTE ON FUNCTION public.resolve_lot_expiry_policy(uuid, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.enforce_lot_expiry_policy()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_expiry_tracked boolean;
  v_policy public.stock_lot_expiry_policies;
  v_expiry date;
  v_signed numeric;
  v_at date := COALESCE(NEW.movement_date::date, CURRENT_DATE);
BEGIN
  IF NEW.product_id IS NULL THEN RETURN NEW; END IF;

  SELECT is_expiry_tracked INTO v_expiry_tracked FROM public.products WHERE id = NEW.product_id;
  IF NOT COALESCE(v_expiry_tracked, false) THEN RETURN NEW; END IF;

  v_signed := public.stock_movement_signed_quantity(NEW.movement_type::text, NEW.quantity);
  IF v_signed = 0 THEN RETURN NEW; END IF;

  v_policy := public.resolve_lot_expiry_policy(NEW.business_id, NEW.product_id);

  SELECT expiry_date INTO v_expiry FROM public.stock_lots
   WHERE business_id = NEW.business_id AND product_id = NEW.product_id
     AND lot_number = NEW.lot_number
   LIMIT 1;

  IF v_signed > 0 THEN
    -- Inbound: expiry-tracked goods should arrive with a known expiry date.
    IF v_policy.require_expiry_on_receipt AND v_expiry IS NULL
       AND v_policy.receipt_enforcement <> 'allow' THEN
      IF v_policy.receipt_enforcement = 'block' THEN
        RAISE EXCEPTION 'INVENTORY_MISSING_EXPIRY: product % is expiry-tracked; lot % has no expiry date',
          NEW.product_id, COALESCE(NEW.lot_number, '(none)') USING ERRCODE = 'check_violation';
      END IF;
      RAISE WARNING 'INVENTORY_MISSING_EXPIRY: lot % received without an expiry date', COALESCE(NEW.lot_number, '(none)');
    END IF;
    RETURN NEW;
  END IF;

  -- Outbound.
  IF v_expiry IS NULL OR v_policy.outbound_enforcement = 'allow' THEN
    RETURN NEW;
  END IF;

  IF v_expiry < v_at THEN
    IF v_policy.outbound_enforcement = 'block' THEN
      RAISE EXCEPTION 'INVENTORY_EXPIRED_LOT: lot % of product % expired on % and cannot be issued on %',
        NEW.lot_number, NEW.product_id, v_expiry, v_at USING ERRCODE = 'check_violation';
    END IF;
    RAISE WARNING 'INVENTORY_EXPIRED_LOT: lot % expired on %', NEW.lot_number, v_expiry;
  ELSIF v_policy.min_shelf_life_days > 0
        AND v_expiry < v_at + v_policy.min_shelf_life_days THEN
    IF v_policy.outbound_enforcement = 'block' THEN
      RAISE EXCEPTION 'INVENTORY_SHELF_LIFE_SHORTFALL: lot % expires on %, less than the required % days remaining',
        NEW.lot_number, v_expiry, v_policy.min_shelf_life_days USING ERRCODE = 'check_violation';
    END IF;
    RAISE WARNING 'INVENTORY_SHELF_LIFE_SHORTFALL: lot % expires on %', NEW.lot_number, v_expiry;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_lot_expiry_policy ON public.stock_movements;
CREATE TRIGGER trg_enforce_lot_expiry_policy
  BEFORE INSERT ON public.stock_movements
  FOR EACH ROW EXECUTE FUNCTION public.enforce_lot_expiry_policy();

-- 4. CANONICAL LOT GENEALOGY -------------------------------------------------
CREATE OR REPLACE FUNCTION public.trace_lot_genealogy(
  p_business_id uuid, p_product_id uuid, p_lot_number text
) RETURNS jsonb
LANGUAGE plpgsql STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_lot public.stock_lots%ROWTYPE;
  v_origin jsonb;
  v_distribution jsonb;
  v_timeline jsonb;
  v_customers jsonb;
  v_quarantine jsonb;
  v_on_hand numeric;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.user_can_access_business(v_user, p_business_id) THEN
    RAISE EXCEPTION 'Forbidden: no access to business %', p_business_id USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_lot FROM public.stock_lots
   WHERE business_id = p_business_id AND product_id = p_product_id AND lot_number = p_lot_number
   LIMIT 1;

  SELECT jsonb_build_object(
    'lot_id', v_lot.id,
    'lot_number', p_lot_number,
    'serial_number', v_lot.serial_number,
    'expiry_date', v_lot.expiry_date,
    'manufacture_date', v_lot.manufacture_date,
    'is_active', v_lot.is_active,
    'notes', v_lot.notes,
    'created_at', v_lot.created_at,
    'product', jsonb_build_object('id', pr.id, 'name', pr.name, 'sku', pr.sku),
    'supplier', CASE WHEN sup.id IS NULL THEN NULL
                     ELSE jsonb_build_object('id', sup.id, 'name', sup.name) END,
    'goods_receipt', CASE WHEN gr.id IS NULL THEN NULL
                     ELSE jsonb_build_object('id', gr.id, 'receipt_number', gr.receipt_number) END,
    'is_expired', (v_lot.expiry_date IS NOT NULL AND v_lot.expiry_date < CURRENT_DATE)
  ) INTO v_origin
  FROM public.products pr
  LEFT JOIN public.contacts sup ON sup.id = v_lot.supplier_id
  LEFT JOIN public.goods_receipts gr ON gr.id = v_lot.goods_receipt_id
  WHERE pr.id = p_product_id;

  SELECT COALESCE(jsonb_agg(d ORDER BY d->>'warehouse_name'), '[]'::jsonb),
         COALESCE(SUM((d->>'quantity')::numeric), 0)
    INTO v_distribution, v_on_hand
  FROM (
    SELECT jsonb_build_object(
             'warehouse_id', sm.warehouse_id,
             'warehouse_name', COALESCE(w.name, '—'),
             'quantity', SUM(public.stock_movement_signed_quantity(sm.movement_type::text, sm.quantity))
           ) AS d
      FROM public.stock_movements sm
      LEFT JOIN public.warehouses w ON w.id = sm.warehouse_id
     WHERE sm.business_id = p_business_id
       AND sm.product_id = p_product_id
       AND sm.lot_number = p_lot_number
       AND sm.warehouse_id IS NOT NULL
     GROUP BY sm.warehouse_id, w.name
  ) s;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', sm.id,
           'movement_date', sm.movement_date,
           'movement_type', sm.movement_type,
           'signed_quantity', public.stock_movement_signed_quantity(sm.movement_type::text, sm.quantity),
           'direction', CASE WHEN public.stock_movement_signed_quantity(sm.movement_type::text, sm.quantity) < 0
                             THEN 'out' ELSE 'in' END,
           'warehouse_id', sm.warehouse_id,
           'warehouse_name', w.name,
           'reference_type', sm.reference_type,
           'reference_id', sm.reference_id,
           'serial_number', sm.serial_number,
           'notes', sm.notes
         ) ORDER BY sm.movement_date, sm.created_at), '[]'::jsonb)
    INTO v_timeline
  FROM public.stock_movements sm
  LEFT JOIN public.warehouses w ON w.id = sm.warehouse_id
  WHERE sm.business_id = p_business_id
    AND sm.product_id = p_product_id
    AND sm.lot_number = p_lot_number;

  SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.customer_name), '[]'::jsonb)
    INTO v_customers
  FROM (
    SELECT c.id AS customer_id,
           COALESCE(c.name, '(unknown)') AS customer_name,
           c.email AS customer_email,
           c.phone AS customer_phone,
           SUM(-public.stock_movement_signed_quantity(sm.movement_type::text, sm.quantity)) AS units_shipped,
           jsonb_agg(DISTINCT jsonb_build_object(
             'document_type', sm.reference_type,
             'document_id', sm.reference_id,
             'document_number', d.doc_number,
             'document_date', d.doc_date
           )) AS documents
      FROM public.stock_movements sm
      JOIN LATERAL (
        SELECT inv.contact_id AS contact_id, inv.invoice_number AS doc_number, inv.issue_date::date AS doc_date
          FROM public.invoices inv
         WHERE sm.reference_type = 'invoice' AND inv.id = sm.reference_id
        UNION ALL
        SELECT dn.contact_id, dn.delivery_number, dn.delivery_date::date
          FROM public.delivery_notes dn
         WHERE sm.reference_type = 'delivery_note' AND dn.id = sm.reference_id
        UNION ALL
        SELECT pt.customer_id, pt.transaction_number, pt.created_at::date
          FROM public.pos_transactions pt
         WHERE sm.reference_type = 'pos_transaction' AND pt.id = sm.reference_id
      ) d ON true
      LEFT JOIN public.contacts c ON c.id = d.contact_id
     WHERE sm.business_id = p_business_id
       AND sm.product_id = p_product_id
       AND sm.lot_number = p_lot_number
       AND public.stock_movement_signed_quantity(sm.movement_type::text, sm.quantity) < 0
     GROUP BY c.id, c.name, c.email, c.phone
  ) t;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', q.id, 'warehouse_id', q.warehouse_id, 'status', q.status,
           'reason', q.reason, 'quarantine_date', q.quarantine_date,
           'released_date', q.released_date, 'recall_id', q.recall_id
         ) ORDER BY q.quarantine_date DESC), '[]'::jsonb)
    INTO v_quarantine
  FROM public.lot_quarantine q
  WHERE q.business_id = p_business_id AND q.lot_id = v_lot.id;

  RETURN jsonb_build_object(
    'origin', v_origin,
    'total_on_hand', COALESCE(v_on_hand, 0),
    'distribution', COALESCE(v_distribution, '[]'::jsonb),
    'timeline', COALESCE(v_timeline, '[]'::jsonb),
    'downstream_customers', COALESCE(v_customers, '[]'::jsonb),
    'quarantine', COALESCE(v_quarantine, '[]'::jsonb)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.trace_lot_genealogy(uuid, uuid, text) TO authenticated, service_role;

-- 5. RECALL USES THE CANONICAL PROJECTION ------------------------------------
CREATE OR REPLACE FUNCTION public.recall_lot(
  p_business_id uuid, p_product_id uuid, p_lot_number text, p_reason text,
  p_severity text DEFAULT 'medium'::text, p_reference text DEFAULT NULL::text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_org_id     uuid;
  v_lot        public.stock_lots%ROWTYPE;
  v_recall_id  uuid;
  v_recall_ref text;
  v_user_id    uuid := auth.uid();
  v_wh         record;
  v_total      numeric := 0;
  v_wh_count   int := 0;
  v_genealogy  jsonb;
  v_customers  jsonb;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;
  IF NOT public.user_can_access_business(v_user_id, p_business_id) THEN
    RAISE EXCEPTION 'Forbidden: no access to business %', p_business_id USING ERRCODE = '42501';
  END IF;
  IF p_lot_number IS NULL OR btrim(p_lot_number) = '' THEN
    RAISE EXCEPTION 'lot_number is required' USING ERRCODE = '22004';
  END IF;

  SELECT * INTO v_lot FROM public.stock_lots
   WHERE business_id = p_business_id AND product_id = p_product_id AND lot_number = p_lot_number
   LIMIT 1;
  IF v_lot.id IS NULL THEN
    RAISE EXCEPTION 'Lot % not found for product % in business %', p_lot_number, p_product_id, p_business_id
      USING ERRCODE = 'P0002';
  END IF;

  v_org_id := v_lot.organization_id;
  v_recall_ref := COALESCE(
    p_reference,
    'RCL-' || to_char(now(), 'YYYYMMDD-HH24MISS') || '-' || substr(replace(v_lot.id::text, '-', ''), 1, 6)
  );

  v_genealogy := public.trace_lot_genealogy(p_business_id, p_product_id, p_lot_number);
  v_customers := COALESCE(v_genealogy->'downstream_customers', '[]'::jsonb);

  INSERT INTO public.product_recalls (
    organization_id, business_id, product_id, recall_reference, reason, severity,
    status, recall_date, initiated_by, notes
  ) VALUES (
    v_org_id, p_business_id, p_product_id, v_recall_ref, p_reason, COALESCE(p_severity, 'medium'),
    'open', CURRENT_DATE, v_user_id, 'Lot ' || v_lot.lot_number
  ) RETURNING id INTO v_recall_id;

  FOR v_wh IN
    SELECT (d->>'warehouse_id')::uuid AS warehouse_id, (d->>'quantity')::numeric AS net_qty
      FROM jsonb_array_elements(COALESCE(v_genealogy->'distribution', '[]'::jsonb)) d
     WHERE (d->>'quantity')::numeric > 0
  LOOP
    INSERT INTO public.lot_quarantine (
      organization_id, business_id, lot_id, warehouse_id, status, reason,
      quarantine_date, authorised_by, recall_id, notes
    ) VALUES (
      v_org_id, p_business_id, v_lot.id, v_wh.warehouse_id, 'quarantined', p_reason,
      now(), v_user_id, v_recall_id, 'Auto-quarantined by recall_lot'
    );

    INSERT INTO public.product_recall_items (
      recall_id, lot_id, warehouse_id, quantity_quarantined, quantity_returned, quantity_destroyed
    ) VALUES (v_recall_id, v_lot.id, v_wh.warehouse_id, v_wh.net_qty, 0, 0);

    v_total := v_total + v_wh.net_qty;
    v_wh_count := v_wh_count + 1;
  END LOOP;

  INSERT INTO public.business_event_outbox (
    org_id, event_type, source_doc_type, source_doc_id,
    payload, idempotency_key, actor_user_id, source
  ) VALUES (
    v_org_id, 'product.recall.opened', 'product_recall', v_recall_id,
    jsonb_build_object(
      'business_id', p_business_id, 'product_id', p_product_id, 'lot_id', v_lot.id,
      'lot_number', v_lot.lot_number, 'recall_reference', v_recall_ref, 'reason', p_reason,
      'severity', COALESCE(p_severity, 'medium'), 'quarantined_units', v_total,
      'warehouses_affected', v_wh_count, 'downstream_customers', v_customers
    ),
    'product.recall.opened:' || v_recall_id::text, v_user_id, 'recall_lot'
  ) ON CONFLICT (idempotency_key) DO NOTHING;

  RETURN jsonb_build_object(
    'success', true,
    'recall_id', v_recall_id,
    'recall_reference', v_recall_ref,
    'quarantined_units', v_total,
    'warehouses_affected', v_wh_count,
    'downstream_customers', v_customers
  );
END;
$function$;

-- 6. SERIAL POSITION DRIFT ---------------------------------------------------
CREATE OR REPLACE FUNCTION public.check_serial_position_drift(p_business_id uuid DEFAULT NULL)
RETURNS TABLE (
  scope text,
  serial_id uuid,
  serial_number text,
  product_id uuid,
  recorded_status text,
  recorded_warehouse_id uuid,
  observed_warehouse_id uuid,
  net_quantity numeric,
  detail text
)
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  WITH scoped AS (
    SELECT s.*
      FROM public.stock_serials s
     WHERE (p_business_id IS NULL OR s.business_id = p_business_id)
       AND public.user_can_access_business(auth.uid(), s.business_id)
  ),
  pos AS (
    SELECT sc.id AS serial_id,
           COALESCE(SUM(public.stock_movement_signed_quantity(sm.movement_type::text, sm.quantity)), 0) AS net_qty,
           (ARRAY_AGG(sm.warehouse_id ORDER BY sm.movement_date DESC, sm.created_at DESC))[1] AS last_wh,
           COUNT(sm.id) AS movement_count
      FROM scoped sc
      LEFT JOIN public.stock_movements sm
        ON sm.business_id = sc.business_id
       AND sm.product_id = sc.product_id
       AND sm.serial_number = sc.serial_number
     GROUP BY sc.id
  )
  SELECT 'status_vs_position'::text, sc.id, sc.serial_number, sc.product_id,
         sc.status::text, sc.current_warehouse_id, pos.last_wh, pos.net_qty,
         format('serial is %s but its movement history nets %s', sc.status, pos.net_qty)
    FROM scoped sc JOIN pos ON pos.serial_id = sc.id
   WHERE (sc.status IN ('in_stock','reserved') AND pos.net_qty <= 0)
      OR (sc.status IN ('shipped','scrapped') AND pos.net_qty > 0)
  UNION ALL
  SELECT 'warehouse_mismatch'::text, sc.id, sc.serial_number, sc.product_id,
         sc.status::text, sc.current_warehouse_id, pos.last_wh, pos.net_qty,
         'recorded warehouse differs from the last movement warehouse'
    FROM scoped sc JOIN pos ON pos.serial_id = sc.id
   WHERE pos.movement_count > 0
     AND pos.last_wh IS NOT NULL
     AND sc.current_warehouse_id IS DISTINCT FROM pos.last_wh
  UNION ALL
  SELECT 'orphan_serial'::text, sc.id, sc.serial_number, sc.product_id,
         sc.status::text, sc.current_warehouse_id, NULL::uuid, 0::numeric,
         'serial has no stock movements'
    FROM scoped sc JOIN pos ON pos.serial_id = sc.id
   WHERE pos.movement_count = 0 AND sc.status <> 'scrapped';
$$;

GRANT EXECUTE ON FUNCTION public.check_serial_position_drift(uuid) TO authenticated, service_role;