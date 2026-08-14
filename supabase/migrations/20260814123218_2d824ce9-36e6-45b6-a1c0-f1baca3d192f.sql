-- ============================================================
-- ADR 0142 — one balance store, one availability engine
-- ============================================================

-- 1. Quant maintenance fails closed --------------------------
CREATE OR REPLACE FUNCTION public._maintain_stock_quants()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_default_location uuid;
  v_source           uuid;
  v_destination      uuid;
  v_qty              numeric := NEW.quantity;
BEGIN
  IF v_qty = 0 THEN RETURN NEW; END IF;

  -- LPN operations relocate plate-scoped quants themselves; the movement
  -- rows they write are an audit trail, not a balance instruction.
  IF NEW.reference_type = 'wms_lpn' THEN RETURN NEW; END IF;

  v_source      := NEW.source_location_id;
  v_destination := NEW.destination_location_id;

  IF v_source IS NULL AND v_destination IS NULL THEN
    IF NEW.warehouse_id IS NULL THEN
      RAISE EXCEPTION 'INVENTORY_MOVEMENT_NO_LOCATION: movement % has neither a warehouse nor source/destination locations; the quant ledger cannot be maintained', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;

    SELECT id INTO v_default_location
    FROM public.stock_locations
    WHERE warehouse_id = NEW.warehouse_id AND is_default
    LIMIT 1;

    IF v_default_location IS NULL THEN
      RAISE EXCEPTION 'INVENTORY_WAREHOUSE_NO_DEFAULT_LOCATION: warehouse % has no default stock location; create one before posting stock', NEW.warehouse_id
        USING ERRCODE = 'check_violation';
    END IF;

    INSERT INTO public.stock_quants AS q
      (organization_id, business_id, branch_id, product_id, location_id, lot_number, quantity)
    VALUES
      (NEW.organization_id, NEW.business_id, NEW.branch_id,
       NEW.product_id, v_default_location, NEW.lot_number, v_qty)
    ON CONFLICT (
      product_id, location_id,
      COALESCE(lot_number, ''),
      COALESCE(package_id, '00000000-0000-0000-0000-000000000000'::uuid),
      COALESCE(owner_id,   '00000000-0000-0000-0000-000000000000'::uuid),
      COALESCE(lpn_id,     '00000000-0000-0000-0000-000000000000'::uuid)
    ) DO UPDATE SET quantity = q.quantity + EXCLUDED.quantity, updated_at = now();
    RETURN NEW;
  END IF;

  IF v_destination IS NOT NULL THEN
    INSERT INTO public.stock_quants AS q
      (organization_id, business_id, branch_id, product_id, location_id, lot_number, quantity)
    VALUES
      (NEW.organization_id, NEW.business_id, NEW.branch_id,
       NEW.product_id, v_destination, NEW.lot_number, ABS(v_qty))
    ON CONFLICT (
      product_id, location_id,
      COALESCE(lot_number, ''),
      COALESCE(package_id, '00000000-0000-0000-0000-000000000000'::uuid),
      COALESCE(owner_id,   '00000000-0000-0000-0000-000000000000'::uuid),
      COALESCE(lpn_id,     '00000000-0000-0000-0000-000000000000'::uuid)
    ) DO UPDATE SET quantity = q.quantity + EXCLUDED.quantity, updated_at = now();
  END IF;

  IF v_source IS NOT NULL THEN
    INSERT INTO public.stock_quants AS q
      (organization_id, business_id, branch_id, product_id, location_id, lot_number, quantity)
    VALUES
      (NEW.organization_id, NEW.business_id, NEW.branch_id,
       NEW.product_id, v_source, NEW.lot_number, -ABS(v_qty))
    ON CONFLICT (
      product_id, location_id,
      COALESCE(lot_number, ''),
      COALESCE(package_id, '00000000-0000-0000-0000-000000000000'::uuid),
      COALESCE(owner_id,   '00000000-0000-0000-0000-000000000000'::uuid),
      COALESCE(lpn_id,     '00000000-0000-0000-0000-000000000000'::uuid)
    ) DO UPDATE SET quantity = q.quantity + EXCLUDED.quantity, updated_at = now();
  END IF;

  RETURN NEW;
END $function$;

-- 2. warehouse_stock becomes a projection of the quant ledger --
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
     AND r.released_at IS NULL
     AND (r.expires_at IS NULL OR r.expires_at > now());

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

REVOKE ALL ON FUNCTION public.refresh_warehouse_stock_projection(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.refresh_warehouse_stock_projection(uuid, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public._project_warehouse_stock_from_quants()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_wh_new uuid;
  v_wh_old uuid;
BEGIN
  IF TG_OP <> 'DELETE' THEN
    SELECT warehouse_id INTO v_wh_new FROM public.stock_locations WHERE id = NEW.location_id;
    PERFORM public.refresh_warehouse_stock_projection(v_wh_new, NEW.product_id);
  END IF;

  IF TG_OP <> 'INSERT' THEN
    SELECT warehouse_id INTO v_wh_old FROM public.stock_locations WHERE id = OLD.location_id;
    IF v_wh_old IS DISTINCT FROM v_wh_new OR TG_OP = 'DELETE' THEN
      PERFORM public.refresh_warehouse_stock_projection(v_wh_old, OLD.product_id);
    END IF;
  END IF;

  RETURN NULL;
END $function$;

DROP TRIGGER IF EXISTS trg_project_warehouse_stock ON public.stock_quants;
CREATE TRIGGER trg_project_warehouse_stock
AFTER INSERT OR UPDATE OR DELETE ON public.stock_quants
FOR EACH ROW EXECUTE FUNCTION public._project_warehouse_stock_from_quants();

CREATE OR REPLACE FUNCTION public._project_warehouse_stock_from_reservations()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP <> 'DELETE' THEN
    PERFORM public.refresh_warehouse_stock_projection(NEW.warehouse_id, NEW.product_id);
  END IF;
  IF TG_OP <> 'INSERT' THEN
    PERFORM public.refresh_warehouse_stock_projection(OLD.warehouse_id, OLD.product_id);
  END IF;
  RETURN NULL;
END $function$;

DROP TRIGGER IF EXISTS trg_project_warehouse_stock_reservations ON public.stock_reservations;
CREATE TRIGGER trg_project_warehouse_stock_reservations
AFTER INSERT OR UPDATE OR DELETE ON public.stock_reservations
FOR EACH ROW EXECUTE FUNCTION public._project_warehouse_stock_from_reservations();

-- 3. The movement trigger stops writing warehouse_stock quantities
CREATE OR REPLACE FUNCTION public.update_product_stock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  -- ADR 0142: warehouse-level balances are projected from stock_quants by
  -- trg_project_warehouse_stock. This trigger only maintains the
  -- company-wide product cache.
  IF TG_OP = 'INSERT' THEN
    UPDATE public.products
       SET stock_quantity = COALESCE(stock_quantity, 0) + NEW.quantity
     WHERE id = NEW.product_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE public.products
       SET stock_quantity = COALESCE(stock_quantity, 0) - OLD.quantity
     WHERE id = OLD.product_id;
  ELSIF TG_OP = 'UPDATE' THEN
    UPDATE public.products
       SET stock_quantity = COALESCE(stock_quantity, 0) - OLD.quantity + NEW.quantity
     WHERE id = NEW.product_id;
  END IF;
  RETURN NULL;
END $function$;

-- 4. Canonical availability engine ---------------------------
CREATE OR REPLACE FUNCTION public.resolve_stock_availability(
  p_product_id   uuid,
  p_business_id  uuid,
  p_branch_id    uuid DEFAULT NULL,
  p_warehouse_id uuid DEFAULT NULL
)
RETURNS TABLE (
  product_id   uuid,
  on_hand      numeric,
  reserved     numeric,
  blocked      numeric,
  in_transit   numeric,
  available    numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
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
     AND r.released_at IS NULL
     AND (r.expires_at IS NULL OR r.expires_at > now())
     AND (p_warehouse_id IS NULL OR r.warehouse_id = p_warehouse_id)
     AND (p_business_id  IS NULL OR r.business_id  = p_business_id)
     AND (p_branch_id    IS NULL OR r.branch_id    = p_branch_id)
     AND COALESCE(w.is_in_transit, false) = false;

  RETURN QUERY SELECT
    p_product_id,
    v_on_hand,
    v_reserved,
    v_blocked,
    v_transit,
    GREATEST(v_on_hand - v_reserved, 0) * 0 + (v_on_hand - v_reserved);
END $function$;

REVOKE ALL ON FUNCTION public.resolve_stock_availability(uuid, uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_stock_availability(uuid, uuid, uuid, uuid) TO authenticated, service_role;

-- 5. Legacy availability functions become wrappers -----------
CREATE OR REPLACE FUNCTION public.get_available_stock(
  p_product_id uuid,
  p_warehouse_id uuid DEFAULT NULL,
  p_business_id uuid DEFAULT NULL,
  p_branch_id uuid DEFAULT NULL
)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v numeric;
BEGIN
  -- ADR 0142: thin wrapper. Do not reimplement availability here.
  SELECT a.available INTO v
    FROM public.resolve_stock_availability(p_product_id, p_business_id, p_branch_id, p_warehouse_id) a;
  RETURN COALESCE(v, 0);
END $function$;

CREATE OR REPLACE FUNCTION public.get_available_pos_stock(
  p_product_id uuid,
  p_register_id uuid
)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_reg RECORD;
  v_warehouse_id uuid;
  v numeric;
BEGIN
  -- ADR 0142: thin wrapper over resolve_stock_availability. The only
  -- POS-specific part is resolving which warehouse the register sells from.
  SELECT pr.branch_id, pr.business_id INTO v_reg
    FROM public.pos_registers pr WHERE pr.id = p_register_id;
  IF NOT FOUND OR v_reg.business_id IS NULL THEN RETURN 0; END IF;

  SELECT ps.warehouse_id INTO v_warehouse_id
    FROM public.pos_shifts ps
   WHERE ps.register_id = p_register_id AND ps.status = 'open'
   ORDER BY ps.opened_at DESC LIMIT 1;

  SELECT a.available INTO v
    FROM public.resolve_stock_availability(
      p_product_id, v_reg.business_id, v_reg.branch_id, v_warehouse_id
    ) a;
  RETURN COALESCE(v, 0);
END $function$;