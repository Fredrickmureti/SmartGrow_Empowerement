-- =====================================================================
-- ADR 0142 Phase 2 — one reservation engine
-- =====================================================================

-- 1. Lifecycle columns on stock_reservations ---------------------------
ALTER TABLE public.stock_reservations
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'reserved',
  ADD COLUMN IF NOT EXISTS quantity_consumed numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS original_quantity numeric,
  ADD COLUMN IF NOT EXISTS location_id uuid,
  ADD COLUMN IF NOT EXISTS lot_number text,
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS release_reason text,
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS consumed_at timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'stock_reservations_status_chk'
  ) THEN
    ALTER TABLE public.stock_reservations
      ADD CONSTRAINT stock_reservations_status_chk
      CHECK (status IN ('reserved','allocated','consumed','released','expired'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'stock_reservations_location_fk'
  ) THEN
    ALTER TABLE public.stock_reservations
      ADD CONSTRAINT stock_reservations_location_fk
      FOREIGN KEY (location_id) REFERENCES public.stock_locations(id);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS stock_reservations_idempotency_uidx
  ON public.stock_reservations (organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS stock_reservations_open_idx
  ON public.stock_reservations (product_id, warehouse_id, status)
  WHERE status IN ('reserved','allocated');

CREATE INDEX IF NOT EXISTS stock_reservations_source_idx
  ON public.stock_reservations (source_type, source_id, product_id);

-- 2. status <-> released_at stay consistent, always ---------------------
CREATE OR REPLACE FUNCTION public._stock_reservations_sync_state()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  NEW.original_quantity := COALESCE(NEW.original_quantity, NEW.quantity);
  NEW.updated_at := now();

  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN
    -- legacy writers may still flip released_at directly
    IF NEW.released_at IS NOT NULL AND OLD.released_at IS NULL
       AND NEW.status IN ('reserved','allocated') THEN
      NEW.status := 'released';
    ELSIF NEW.released_at IS NULL AND OLD.released_at IS NOT NULL THEN
      NEW.status := 'reserved';
    END IF;
  END IF;

  IF NEW.status IN ('released','expired','consumed') THEN
    NEW.released_at := COALESCE(NEW.released_at, now());
  ELSE
    NEW.released_at := NULL;
  END IF;

  IF NEW.status = 'consumed' THEN
    NEW.consumed_at := COALESCE(NEW.consumed_at, now());
  END IF;

  RETURN NEW;
END $function$;

DROP TRIGGER IF EXISTS trg_stock_reservations_sync_state ON public.stock_reservations;
CREATE TRIGGER trg_stock_reservations_sync_state
BEFORE INSERT OR UPDATE ON public.stock_reservations
FOR EACH ROW EXECUTE FUNCTION public._stock_reservations_sync_state();

-- 3. Open-hold predicate is one function ------------------------------
CREATE OR REPLACE FUNCTION public.stock_reservation_is_open(
  p_status text, p_expires_at timestamptz
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT p_status IN ('reserved','allocated')
     AND (p_expires_at IS NULL OR p_expires_at > now());
$function$;

-- 4. Projections read the lifecycle, not released_at -------------------
CREATE OR REPLACE FUNCTION public.refresh_warehouse_stock_projection(
  p_warehouse_id uuid,
  p_product_id   uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_wh       RECORD;
  v_qty      numeric := 0;
  v_reserved numeric := 0;
BEGIN
  IF p_warehouse_id IS NULL OR p_product_id IS NULL THEN RETURN; END IF;

  SELECT id, organization_id, business_id, branch_id
    INTO v_wh
    FROM public.warehouses WHERE id = p_warehouse_id;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT COALESCE(SUM(q.quantity), 0)
    INTO v_qty
    FROM public.stock_quants q
    JOIN public.stock_locations l ON l.id = q.location_id
   WHERE l.warehouse_id = p_warehouse_id
     AND q.product_id   = p_product_id;

  SELECT COALESCE(SUM(r.quantity), 0)
    INTO v_reserved
    FROM public.stock_reservations r
   WHERE r.warehouse_id = p_warehouse_id
     AND r.product_id   = p_product_id
     AND public.stock_reservation_is_open(r.status, r.expires_at);

  INSERT INTO public.warehouse_stock AS ws (
    organization_id, business_id, branch_id,
    warehouse_id, product_id, quantity, reserved_quantity
  ) VALUES (
    v_wh.organization_id, v_wh.business_id, v_wh.branch_id,
    p_warehouse_id, p_product_id, v_qty, v_reserved
  )
  ON CONFLICT (business_id, warehouse_id, product_id) DO UPDATE
     SET quantity          = EXCLUDED.quantity,
         reserved_quantity = EXCLUDED.reserved_quantity,
         updated_at        = now();
END $function$;

-- bin-grain reserved is derived too, whenever a hold names a location
CREATE OR REPLACE FUNCTION public.refresh_quant_reserved_projection(
  p_location_id uuid,
  p_product_id  uuid,
  p_lot_number  text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_reserved numeric := 0;
BEGIN
  IF p_location_id IS NULL OR p_product_id IS NULL THEN RETURN; END IF;

  SELECT COALESCE(SUM(r.quantity), 0)
    INTO v_reserved
    FROM public.stock_reservations r
   WHERE r.location_id = p_location_id
     AND r.product_id  = p_product_id
     AND r.lot_number IS NOT DISTINCT FROM p_lot_number
     AND public.stock_reservation_is_open(r.status, r.expires_at);

  UPDATE public.stock_quants
     SET reserved_quantity = v_reserved,
         updated_at = now()
   WHERE location_id = p_location_id
     AND product_id  = p_product_id
     AND lot_number IS NOT DISTINCT FROM p_lot_number;
END $function$;

CREATE OR REPLACE FUNCTION public._project_warehouse_stock_from_reservations()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP <> 'DELETE' THEN
    PERFORM public.refresh_warehouse_stock_projection(NEW.warehouse_id, NEW.product_id);
    IF NEW.location_id IS NOT NULL THEN
      PERFORM public.refresh_quant_reserved_projection(NEW.location_id, NEW.product_id, NEW.lot_number);
    END IF;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    PERFORM public.refresh_warehouse_stock_projection(OLD.warehouse_id, OLD.product_id);
    IF OLD.location_id IS NOT NULL THEN
      PERFORM public.refresh_quant_reserved_projection(OLD.location_id, OLD.product_id, OLD.lot_number);
    END IF;
  END IF;
  RETURN NULL;
END $function$;

-- availability counts open holds by lifecycle
CREATE OR REPLACE FUNCTION public.resolve_stock_availability(
  p_product_id uuid,
  p_business_id uuid,
  p_branch_id uuid DEFAULT NULL::uuid,
  p_warehouse_id uuid DEFAULT NULL::uuid
)
RETURNS TABLE(product_id uuid, on_hand numeric, reserved numeric, blocked numeric, in_transit numeric, available numeric)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_on_hand    numeric := 0;
  v_blocked    numeric := 0;
  v_transit    numeric := 0;
  v_reserved   numeric := 0;
BEGIN
  IF p_product_id IS NULL THEN
    RAISE EXCEPTION 'INVENTORY_AVAILABILITY_NO_PRODUCT: product is required';
  END IF;
  IF p_business_id IS NULL AND p_warehouse_id IS NULL THEN
    RAISE EXCEPTION 'INVENTORY_AVAILABILITY_NO_SCOPE: a business or a warehouse is required';
  END IF;

  SELECT
    COALESCE(SUM(q.quantity) FILTER (
      WHERE l.location_type = 'internal'
        AND COALESCE(l.is_blocked, false) = false
        AND COALESCE(w.is_in_transit, false) = false
    ), 0),
    COALESCE(SUM(q.quantity) FILTER (
      WHERE l.location_type = 'quarantine' OR COALESCE(l.is_blocked, false)
    ), 0),
    COALESCE(SUM(q.quantity) FILTER (
      WHERE l.location_type = 'transit' OR COALESCE(w.is_in_transit, false)
    ), 0)
  INTO v_on_hand, v_blocked, v_transit
  FROM public.stock_quants q
  JOIN public.stock_locations l ON l.id = q.location_id
  LEFT JOIN public.warehouses w ON w.id = l.warehouse_id
  WHERE q.product_id = p_product_id
    AND (p_warehouse_id IS NULL OR l.warehouse_id = p_warehouse_id)
    AND (p_business_id  IS NULL OR q.business_id  = p_business_id)
    AND (p_branch_id    IS NULL OR q.branch_id    = p_branch_id);

  SELECT COALESCE(SUM(r.quantity), 0)
    INTO v_reserved
    FROM public.stock_reservations r
    LEFT JOIN public.warehouses w ON w.id = r.warehouse_id
   WHERE r.product_id = p_product_id
     AND public.stock_reservation_is_open(r.status, r.expires_at)
     AND (p_warehouse_id IS NULL OR r.warehouse_id = p_warehouse_id)
     AND (p_business_id  IS NULL OR r.business_id  = p_business_id)
     AND (p_branch_id    IS NULL OR r.branch_id    = p_branch_id)
     AND COALESCE(w.is_in_transit, false) = false;

  RETURN QUERY SELECT p_product_id, v_on_hand, v_reserved, v_blocked, v_transit,
                      (v_on_hand - v_reserved);
END $function$;

-- =====================================================================
-- 5. THE reservation engine
-- =====================================================================
CREATE OR REPLACE FUNCTION public.reserve_stock_atomic(
  p_organization_id uuid,
  p_product_id      uuid,
  p_quantity        numeric,
  p_source_type     text,
  p_source_id       uuid        DEFAULT NULL,
  p_warehouse_id    uuid        DEFAULT NULL,
  p_location_id     uuid        DEFAULT NULL,
  p_lot_number      text        DEFAULT NULL,
  p_lot_id          uuid        DEFAULT NULL,
  p_expires_at      timestamptz DEFAULT NULL,
  p_idempotency_key text        DEFAULT NULL,
  p_allow_partial   boolean     DEFAULT false,
  p_reserved_by     uuid        DEFAULT NULL,
  p_metadata        jsonb       DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_wh          RECORD;
  v_business_id uuid;
  v_branch_id   uuid;
  v_available   numeric := 0;
  v_take        numeric;
  v_id          uuid;
  v_existing    RECORD;
BEGIN
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'quantity_must_be_positive');
  END IF;
  IF p_product_id IS NULL OR p_organization_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'product_and_organization_required');
  END IF;
  IF p_source_type NOT IN ('pos','sales_order','transfer','manual','physical_count','pick_wave','replenishment','work_order') THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_source_type');
  END IF;

  -- idempotency: the same command never holds stock twice
  IF p_idempotency_key IS NOT NULL THEN
    SELECT id, quantity, status INTO v_existing
      FROM public.stock_reservations
     WHERE organization_id = p_organization_id
       AND idempotency_key = p_idempotency_key;
    IF FOUND THEN
      RETURN jsonb_build_object('success', true, 'reservation_id', v_existing.id,
                                'reserved', v_existing.quantity,
                                'status', v_existing.status, 'idempotent_replay', true);
    END IF;
  END IF;

  IF p_warehouse_id IS NULL AND p_location_id IS NOT NULL THEN
    SELECT warehouse_id INTO p_warehouse_id
      FROM public.stock_locations WHERE id = p_location_id;
  END IF;
  IF p_warehouse_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'warehouse_or_location_required');
  END IF;

  SELECT id, organization_id, business_id, branch_id
    INTO v_wh FROM public.warehouses WHERE id = p_warehouse_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'warehouse_not_found');
  END IF;
  IF v_wh.organization_id IS DISTINCT FROM p_organization_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'warehouse_belongs_to_different_workspace');
  END IF;
  v_business_id := v_wh.business_id;
  v_branch_id   := v_wh.branch_id;

  -- serialise concurrent holds on the same physical stock
  PERFORM 1 FROM public.stock_quants q
    JOIN public.stock_locations l ON l.id = q.location_id
   WHERE q.product_id = p_product_id
     AND l.warehouse_id = p_warehouse_id
     AND (p_location_id IS NULL OR q.location_id = p_location_id)
   FOR UPDATE OF q;

  IF p_location_id IS NOT NULL THEN
    SELECT COALESCE(SUM(q.quantity), 0)
      INTO v_available
      FROM public.stock_quants q
     WHERE q.product_id = p_product_id
       AND q.location_id = p_location_id
       AND (p_lot_number IS NULL OR q.lot_number IS NOT DISTINCT FROM p_lot_number);

    v_available := v_available - COALESCE((
      SELECT SUM(r.quantity) FROM public.stock_reservations r
       WHERE r.location_id = p_location_id
         AND r.product_id  = p_product_id
         AND (p_lot_number IS NULL OR r.lot_number IS NOT DISTINCT FROM p_lot_number)
         AND public.stock_reservation_is_open(r.status, r.expires_at)
    ), 0);
  ELSE
    SELECT a.available INTO v_available
      FROM public.resolve_stock_availability(
             p_product_id, v_business_id, v_branch_id, p_warehouse_id) a;
  END IF;

  v_available := COALESCE(v_available, 0);

  IF v_available < p_quantity THEN
    IF NOT p_allow_partial OR v_available <= 0 THEN
      RETURN jsonb_build_object('success', false, 'error', 'insufficient_stock',
                                'available', v_available, 'requested', p_quantity);
    END IF;
    v_take := v_available;
  ELSE
    v_take := p_quantity;
  END IF;

  INSERT INTO public.stock_reservations (
    organization_id, business_id, branch_id, warehouse_id, location_id,
    product_id, lot_id, lot_number, quantity, original_quantity,
    source_type, source_id, reserved_by, expires_at,
    idempotency_key, status, metadata
  ) VALUES (
    p_organization_id, v_business_id, v_branch_id, p_warehouse_id, p_location_id,
    p_product_id, p_lot_id, p_lot_number, v_take, v_take,
    p_source_type, p_source_id, COALESCE(p_reserved_by, auth.uid()), p_expires_at,
    p_idempotency_key, 'reserved', COALESCE(p_metadata, '{}'::jsonb)
  ) RETURNING id INTO v_id;

  RETURN jsonb_build_object(
    'success', true,
    'reservation_id', v_id,
    'reserved', v_take,
    'requested', p_quantity,
    'partial', v_take < p_quantity,
    'status', 'reserved',
    'available', v_available - v_take
  );
END $function$;

CREATE OR REPLACE FUNCTION public.allocate_stock_reservation(
  p_organization_id uuid,
  p_reservation_id  uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_res RECORD;
BEGIN
  SELECT * INTO v_res FROM public.stock_reservations
   WHERE id = p_reservation_id AND organization_id = p_organization_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'reservation_not_found');
  END IF;
  IF v_res.status <> 'reserved' THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_transition',
                              'status', v_res.status);
  END IF;
  UPDATE public.stock_reservations SET status = 'allocated' WHERE id = p_reservation_id;
  RETURN jsonb_build_object('success', true, 'status', 'allocated');
END $function$;

DROP FUNCTION IF EXISTS public.release_stock_reservation(uuid, uuid);
CREATE OR REPLACE FUNCTION public.release_stock_reservation(
  p_organization_id uuid,
  p_reservation_id  uuid,
  p_reason          text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_res RECORD;
BEGIN
  SELECT * INTO v_res FROM public.stock_reservations
   WHERE id = p_reservation_id
     AND organization_id = p_organization_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'reservation_not_found');
  END IF;
  IF v_res.status NOT IN ('reserved','allocated') THEN
    RETURN jsonb_build_object('success', false, 'error', 'reservation_not_open',
                              'status', v_res.status);
  END IF;

  UPDATE public.stock_reservations
     SET status = 'released', release_reason = p_reason
   WHERE id = p_reservation_id;

  RETURN jsonb_build_object('success', true, 'released', v_res.quantity);
END $function$;

CREATE OR REPLACE FUNCTION public.release_stock_reservations_for_source(
  p_organization_id uuid,
  p_source_type     text,
  p_source_id       uuid,
  p_product_id      uuid DEFAULT NULL,
  p_reason          text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_n int := 0; v_qty numeric := 0;
BEGIN
  WITH released AS (
    UPDATE public.stock_reservations
       SET status = 'released', release_reason = p_reason
     WHERE organization_id = p_organization_id
       AND source_type = p_source_type
       AND source_id IS NOT DISTINCT FROM p_source_id
       AND (p_product_id IS NULL OR product_id = p_product_id)
       AND status IN ('reserved','allocated')
    RETURNING quantity
  )
  SELECT count(*), COALESCE(SUM(quantity), 0) INTO v_n, v_qty FROM released;

  RETURN jsonb_build_object('success', true, 'released', v_n, 'quantity', v_qty);
END $function$;

CREATE OR REPLACE FUNCTION public.consume_stock_reservation(
  p_organization_id uuid,
  p_reservation_id  uuid,
  p_quantity        numeric DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_res RECORD; v_take numeric;
BEGIN
  SELECT * INTO v_res FROM public.stock_reservations
   WHERE id = p_reservation_id AND organization_id = p_organization_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'reservation_not_found');
  END IF;
  IF v_res.status NOT IN ('reserved','allocated') THEN
    RETURN jsonb_build_object('success', false, 'error', 'reservation_not_open',
                              'status', v_res.status);
  END IF;

  v_take := LEAST(COALESCE(p_quantity, v_res.quantity), v_res.quantity);
  IF v_take <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'quantity_must_be_positive');
  END IF;

  IF v_take >= v_res.quantity THEN
    UPDATE public.stock_reservations
       SET quantity = 0,
           quantity_consumed = COALESCE(quantity_consumed, 0) + v_take,
           status = 'consumed'
     WHERE id = p_reservation_id;
  ELSE
    UPDATE public.stock_reservations
       SET quantity = quantity - v_take,
           quantity_consumed = COALESCE(quantity_consumed, 0) + v_take
     WHERE id = p_reservation_id;
  END IF;

  RETURN jsonb_build_object('success', true, 'consumed', v_take,
                            'remaining', GREATEST(v_res.quantity - v_take, 0));
END $function$;

CREATE OR REPLACE FUNCTION public.consume_stock_reservations_for_source(
  p_organization_id uuid,
  p_source_type     text,
  p_source_id       uuid,
  p_product_id      uuid,
  p_quantity        numeric
)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_left numeric := COALESCE(p_quantity, 0);
  v_take numeric;
  r RECORD;
BEGIN
  IF v_left <= 0 OR p_product_id IS NULL THEN RETURN 0; END IF;

  FOR r IN
    SELECT id, quantity FROM public.stock_reservations
     WHERE organization_id = p_organization_id
       AND source_type = p_source_type
       AND source_id IS NOT DISTINCT FROM p_source_id
       AND product_id = p_product_id
       AND status IN ('reserved','allocated')
       AND quantity > 0
     ORDER BY created_at
     FOR UPDATE
  LOOP
    EXIT WHEN v_left <= 0;
    v_take := LEAST(r.quantity, v_left);
    PERFORM public.consume_stock_reservation(p_organization_id, r.id, v_take);
    v_left := v_left - v_take;
  END LOOP;

  RETURN COALESCE(p_quantity, 0) - v_left;
END $function$;

CREATE OR REPLACE FUNCTION public.expire_stock_reservations()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_count integer := 0;
BEGIN
  WITH expired AS (
    UPDATE public.stock_reservations
       SET status = 'expired', release_reason = 'expired'
     WHERE status IN ('reserved','allocated')
       AND expires_at IS NOT NULL
       AND expires_at < now()
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM expired;
  RETURN v_count;
END $function$;

-- =====================================================================
-- 6. Duplicate engines removed
-- =====================================================================
DROP FUNCTION IF EXISTS public.reserve_stock(uuid, uuid, uuid, numeric, text, uuid);
DROP FUNCTION IF EXISTS public.create_stock_reservation(uuid, uuid, uuid, numeric, text, uuid, timestamptz, uuid);

-- =====================================================================
-- 7. Consumers repointed onto the engine
-- =====================================================================
CREATE OR REPLACE FUNCTION public.confirm_sales_order_atomic(p_so_id uuid, p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_so          RECORD;
  v_warehouse_id uuid;
  v_item        RECORD;
  v_res         jsonb;
  v_reservations_created int := 0;
  v_reservations_skipped int := 0;
  v_skip_reasons jsonb := '[]'::jsonb;
BEGIN
  SELECT id, organization_id, business_id, branch_id, status, so_number
    INTO v_so FROM sales_orders WHERE id = p_so_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sales order not found');
  END IF;

  IF v_so.status NOT IN ('draft','approved') THEN
    RETURN jsonb_build_object('success', false, 'error',
      'Only draft or approved sales orders can be confirmed. Current status: ' || v_so.status);
  END IF;

  SELECT id INTO v_warehouse_id
    FROM warehouses
   WHERE organization_id = v_so.organization_id
     AND business_id = v_so.business_id
     AND COALESCE(branch_id, '00000000-0000-0000-0000-000000000000'::uuid)
         = COALESCE(v_so.branch_id, '00000000-0000-0000-0000-000000000000'::uuid)
     AND is_active = true
     AND COALESCE(is_in_transit, false) = false
   ORDER BY is_default DESC NULLS LAST
   LIMIT 1;

  IF v_warehouse_id IS NOT NULL THEN
    FOR v_item IN
      SELECT soi.id AS item_id, soi.product_id, soi.quantity, soi.quantity_fulfilled
        FROM sales_order_items soi
        LEFT JOIN products p ON p.id = soi.product_id
       WHERE soi.sales_order_id = p_so_id
         AND soi.product_id IS NOT NULL
         AND COALESCE(p.track_inventory, false) = true
         AND (soi.quantity - COALESCE(soi.quantity_fulfilled, 0)) > 0
    LOOP
      v_res := public.reserve_stock_atomic(
        p_organization_id => v_so.organization_id,
        p_product_id      => v_item.product_id,
        p_quantity        => v_item.quantity - COALESCE(v_item.quantity_fulfilled, 0),
        p_source_type     => 'sales_order',
        p_source_id       => p_so_id,
        p_warehouse_id    => v_warehouse_id,
        p_idempotency_key => 'sales_order:' || p_so_id::text || ':' || v_item.item_id::text,
        p_reserved_by     => p_user_id
      );

      IF COALESCE((v_res->>'success')::boolean, false) THEN
        v_reservations_created := v_reservations_created + 1;
      ELSE
        v_reservations_skipped := v_reservations_skipped + 1;
        v_skip_reasons := v_skip_reasons || jsonb_build_object(
          'product_id', v_item.product_id,
          'reason', COALESCE(v_res->>'error', 'unknown'),
          'available', v_res->'available'
        );
      END IF;
    END LOOP;
  END IF;

  UPDATE sales_orders SET status = 'confirmed', updated_at = now() WHERE id = p_so_id;

  RETURN jsonb_build_object(
    'success', true,
    'so_id', p_so_id,
    'reservations_created', v_reservations_created,
    'reservations_skipped', v_reservations_skipped,
    'skip_reasons', v_skip_reasons,
    'warehouse_resolved', v_warehouse_id IS NOT NULL
  );
END $function$;

CREATE OR REPLACE FUNCTION public.consume_so_reservation(
  p_org_id uuid, p_so_id uuid, p_product_id uuid, p_qty numeric
)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  RETURN public.consume_stock_reservations_for_source(
    p_org_id, 'sales_order', p_so_id, p_product_id, p_qty);
END $function$;

CREATE OR REPLACE FUNCTION public._wms_consume_order_reservation(
  p_sales_order_id uuid, p_product_id uuid, p_qty numeric
)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_org uuid;
BEGIN
  IF p_sales_order_id IS NULL OR COALESCE(p_qty,0) <= 0 THEN RETURN 0; END IF;
  SELECT organization_id INTO v_org FROM public.sales_orders WHERE id = p_sales_order_id;
  IF v_org IS NULL THEN RETURN 0; END IF;
  RETURN public.consume_stock_reservations_for_source(
    v_org, 'sales_order', p_sales_order_id, p_product_id, p_qty);
END $function$;

CREATE OR REPLACE FUNCTION public.restore_so_reservation(
  p_org_id uuid, p_so_id uuid, p_product_id uuid, p_qty numeric
)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_remaining numeric := COALESCE(p_qty, 0);
  v_res RECORD;
  v_give numeric;
BEGIN
  IF v_remaining <= 0 OR p_product_id IS NULL THEN RETURN 0; END IF;

  FOR v_res IN
    SELECT id, quantity, quantity_consumed, status
      FROM public.stock_reservations
     WHERE organization_id = p_org_id
       AND source_type = 'sales_order'
       AND source_id   = p_so_id
       AND product_id  = p_product_id
       AND COALESCE(quantity_consumed, 0) > 0
     ORDER BY created_at DESC
     FOR UPDATE
  LOOP
    EXIT WHEN v_remaining <= 0;
    v_give := LEAST(v_res.quantity_consumed, v_remaining);
    IF v_give <= 0 THEN CONTINUE; END IF;

    UPDATE public.stock_reservations
       SET quantity = quantity + v_give,
           quantity_consumed = quantity_consumed - v_give,
           status = 'reserved',
           consumed_at = NULL
     WHERE id = v_res.id;

    v_remaining := v_remaining - v_give;
  END LOOP;

  RETURN COALESCE(p_qty,0) - v_remaining;
END $function$;

CREATE OR REPLACE FUNCTION public.release_sales_order_reservations_atomic(p_so_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_org_id uuid; v_out jsonb;
BEGIN
  SELECT organization_id INTO v_org_id FROM public.sales_orders WHERE id = p_so_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sales order not found');
  END IF;
  v_out := public.release_stock_reservations_for_source(
             v_org_id, 'sales_order', p_so_id, NULL, 'sales order reservations released');
  RETURN jsonb_build_object('success', true, 'released', v_out->'released');
END $function$;

CREATE OR REPLACE FUNCTION public.reserve_pos_stock(
  p_organization_id uuid,
  p_product_id uuid,
  p_register_id uuid,
  p_quantity numeric,
  p_reserved_by uuid DEFAULT NULL::uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_register RECORD;
  v_warehouse_id uuid;
  v_res jsonb;
BEGIN
  PERFORM public.expire_stock_reservations();

  SELECT business_id, branch_id, organization_id
    INTO v_register FROM public.pos_registers WHERE id = p_register_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'register_not_found');
  END IF;
  IF v_register.organization_id IS DISTINCT FROM p_organization_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'register_belongs_to_different_org');
  END IF;

  SELECT s.warehouse_id INTO v_warehouse_id
    FROM public.pos_shifts s
   WHERE s.register_id = p_register_id AND s.status = 'open'
   ORDER BY s.opened_at DESC LIMIT 1;
  IF v_warehouse_id IS NULL THEN
    SELECT w.id INTO v_warehouse_id
      FROM public.warehouses w
     WHERE w.business_id = v_register.business_id
       AND w.branch_id   = v_register.branch_id
       AND w.is_active   = true
       AND COALESCE(w.is_in_transit, false) = false
     ORDER BY w.is_default DESC, w.created_at ASC LIMIT 1;
  END IF;
  IF v_warehouse_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'no_warehouse_for_register');
  END IF;

  -- one open hold per (register, product)
  PERFORM public.release_stock_reservations_for_source(
    p_organization_id, 'pos', p_register_id, p_product_id, 'superseded by new POS hold');

  v_res := public.reserve_stock_atomic(
    p_organization_id => p_organization_id,
    p_product_id      => p_product_id,
    p_quantity        => p_quantity,
    p_source_type     => 'pos',
    p_source_id       => p_register_id,
    p_warehouse_id    => v_warehouse_id,
    p_expires_at      => now() + interval '15 minutes',
    p_reserved_by     => p_reserved_by
  );

  RETURN v_res;
END $function$;

CREATE OR REPLACE FUNCTION public.release_pos_stock_reservation(
  p_register_id uuid, p_product_id uuid DEFAULT NULL::uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_org uuid;
BEGIN
  SELECT organization_id INTO v_org FROM public.pos_registers WHERE id = p_register_id;
  IF v_org IS NULL THEN RETURN; END IF;
  PERFORM public.release_stock_reservations_for_source(
    v_org, 'pos', p_register_id, p_product_id, 'pos hold released');
END $function$;

CREATE OR REPLACE FUNCTION public._wms_replen_reserve(p_order wms_replen_orders, p_qty numeric)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_res jsonb;
BEGIN
  IF p_order.source_location_id IS NULL OR COALESCE(p_qty,0) <= 0 THEN RETURN 0; END IF;

  v_res := public.reserve_stock_atomic(
    p_organization_id => p_order.organization_id,
    p_product_id      => p_order.product_id,
    p_quantity        => p_qty,
    p_source_type     => 'replenishment',
    p_source_id       => p_order.id,
    p_location_id     => p_order.source_location_id,
    p_lot_number      => p_order.lot_number,
    p_allow_partial   => true
  );

  IF NOT COALESCE((v_res->>'success')::boolean, false) THEN RETURN 0; END IF;
  RETURN COALESCE((v_res->>'reserved')::numeric, 0);
END $function$;

CREATE OR REPLACE FUNCTION public._release_physical_count_reservations(p_count_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_org uuid; v_out jsonb;
BEGIN
  SELECT organization_id INTO v_org FROM public.physical_counts WHERE id = p_count_id;
  IF v_org IS NULL THEN RETURN 0; END IF;
  v_out := public.release_stock_reservations_for_source(
    v_org, 'physical_count', p_count_id, NULL, 'physical count released');
  RETURN COALESCE((v_out->>'released')::int, 0);
END $function$;

-- =====================================================================
-- 8. Grants
-- =====================================================================
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.reserve_stock_atomic(uuid,uuid,numeric,text,uuid,uuid,uuid,text,uuid,timestamptz,text,boolean,uuid,jsonb)',
    'public.allocate_stock_reservation(uuid,uuid)',
    'public.release_stock_reservation(uuid,uuid,text)',
    'public.release_stock_reservations_for_source(uuid,text,uuid,uuid,text)',
    'public.consume_stock_reservation(uuid,uuid,numeric)',
    'public.consume_stock_reservations_for_source(uuid,text,uuid,uuid,numeric)',
    'public.expire_stock_reservations()',
    'public.refresh_quant_reserved_projection(uuid,uuid,text)',
    'public.stock_reservation_is_open(text,timestamptz)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', f);
  END LOOP;
END $$;