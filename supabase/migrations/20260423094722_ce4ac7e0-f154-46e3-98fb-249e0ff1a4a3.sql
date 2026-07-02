
-- =====================================================================
-- PHASE 5 — Lot/serial tracking schema + unified stock reservations
-- =====================================================================

-- 1. stock_lots
CREATE TABLE IF NOT EXISTS public.stock_lots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  lot_number TEXT NOT NULL,
  serial_number TEXT,
  manufacture_date DATE,
  expiry_date DATE,
  supplier_id UUID REFERENCES public.contacts(id) ON DELETE SET NULL,
  goods_receipt_id UUID,
  notes TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT stock_lots_business_lot_unique UNIQUE (business_id, product_id, lot_number, serial_number)
);

CREATE INDEX IF NOT EXISTS idx_stock_lots_business_product ON public.stock_lots(business_id, product_id);
CREATE INDEX IF NOT EXISTS idx_stock_lots_expiry ON public.stock_lots(business_id, expiry_date) WHERE expiry_date IS NOT NULL;

-- 2. warehouse_stock_lots (future "quant" table)
CREATE TABLE IF NOT EXISTS public.warehouse_stock_lots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  warehouse_id UUID NOT NULL REFERENCES public.warehouses(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  lot_id UUID NOT NULL REFERENCES public.stock_lots(id) ON DELETE RESTRICT,
  quantity NUMERIC(20, 6) NOT NULL DEFAULT 0,
  reserved_quantity NUMERIC(20, 6) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT warehouse_stock_lots_unique UNIQUE (business_id, warehouse_id, product_id, lot_id),
  CONSTRAINT warehouse_stock_lots_qty_nonneg CHECK (quantity >= 0),
  CONSTRAINT warehouse_stock_lots_reserved_nonneg CHECK (reserved_quantity >= 0)
);

CREATE INDEX IF NOT EXISTS idx_wsl_business_warehouse_product ON public.warehouse_stock_lots(business_id, warehouse_id, product_id);
CREATE INDEX IF NOT EXISTS idx_wsl_lot ON public.warehouse_stock_lots(lot_id);

-- 3. Unified stock_reservations
CREATE TABLE IF NOT EXISTS public.stock_reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  branch_id UUID REFERENCES public.branches(id) ON DELETE CASCADE,
  warehouse_id UUID REFERENCES public.warehouses(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  lot_id UUID REFERENCES public.stock_lots(id) ON DELETE RESTRICT,
  quantity NUMERIC(20, 6) NOT NULL CHECK (quantity > 0),
  source_type TEXT NOT NULL CHECK (source_type IN ('pos','sales_order','transfer','manual')),
  source_id UUID,
  reserved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  expires_at TIMESTAMPTZ,
  released_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sr_active
  ON public.stock_reservations(business_id, warehouse_id, product_id)
  WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_sr_source ON public.stock_reservations(source_type, source_id) WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_sr_expiring ON public.stock_reservations(expires_at) WHERE released_at IS NULL AND expires_at IS NOT NULL;

-- 4. RLS — use is_org_member(user_id, org_id)
ALTER TABLE public.stock_lots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.warehouse_stock_lots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_reservations ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "stock_lots org members read"
    ON public.stock_lots FOR SELECT TO authenticated
    USING (public.is_org_member(auth.uid(), organization_id));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "stock_lots org members write"
    ON public.stock_lots FOR ALL TO authenticated
    USING (public.is_org_member(auth.uid(), organization_id))
    WITH CHECK (public.is_org_member(auth.uid(), organization_id));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "warehouse_stock_lots org members read"
    ON public.warehouse_stock_lots FOR SELECT TO authenticated
    USING (public.is_org_member(auth.uid(), organization_id));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "warehouse_stock_lots org members write"
    ON public.warehouse_stock_lots FOR ALL TO authenticated
    USING (public.is_org_member(auth.uid(), organization_id))
    WITH CHECK (public.is_org_member(auth.uid(), organization_id));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "stock_reservations org members read"
    ON public.stock_reservations FOR SELECT TO authenticated
    USING (public.is_org_member(auth.uid(), organization_id));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "stock_reservations org members write"
    ON public.stock_reservations FOR ALL TO authenticated
    USING (public.is_org_member(auth.uid(), organization_id))
    WITH CHECK (public.is_org_member(auth.uid(), organization_id));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 5. updated_at triggers
DROP TRIGGER IF EXISTS trg_stock_lots_updated_at ON public.stock_lots;
CREATE TRIGGER trg_stock_lots_updated_at
  BEFORE UPDATE ON public.stock_lots
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS trg_warehouse_stock_lots_updated_at ON public.warehouse_stock_lots;
CREATE TRIGGER trg_warehouse_stock_lots_updated_at
  BEFORE UPDATE ON public.warehouse_stock_lots
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 6. Unified reservation RPCs
CREATE OR REPLACE FUNCTION public.create_stock_reservation(
  p_organization_id UUID,
  p_product_id UUID,
  p_warehouse_id UUID,
  p_quantity NUMERIC,
  p_source_type TEXT,
  p_source_id UUID DEFAULT NULL,
  p_expires_at TIMESTAMPTZ DEFAULT NULL,
  p_lot_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_wh RECORD;
  v_on_hand NUMERIC;
  v_reserved NUMERIC;
  v_available NUMERIC;
  v_reservation_id UUID;
BEGIN
  IF p_quantity <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Quantity must be positive');
  END IF;

  IF p_source_type NOT IN ('pos','sales_order','transfer','manual') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invalid source_type');
  END IF;

  SELECT business_id, branch_id, organization_id INTO v_wh
    FROM public.warehouses WHERE id = p_warehouse_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Warehouse not found');
  END IF;

  IF v_wh.organization_id IS DISTINCT FROM p_organization_id THEN
    RETURN jsonb_build_object('success', false, 'error',
      'Warehouse belongs to a different workspace');
  END IF;

  SELECT quantity, reserved_quantity
    INTO v_on_hand, v_reserved
    FROM public.warehouse_stock
   WHERE organization_id = p_organization_id
     AND business_id     = v_wh.business_id
     AND product_id      = p_product_id
     AND warehouse_id    = p_warehouse_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'No stock record found', 'available', 0);
  END IF;

  v_available := COALESCE(v_on_hand, 0) - COALESCE(v_reserved, 0);

  IF v_available < p_quantity THEN
    RETURN jsonb_build_object('success', false, 'error', 'Insufficient available stock', 'available', v_available);
  END IF;

  UPDATE public.warehouse_stock
     SET reserved_quantity = COALESCE(reserved_quantity, 0) + p_quantity,
         updated_at = now()
   WHERE organization_id = p_organization_id
     AND business_id     = v_wh.business_id
     AND product_id      = p_product_id
     AND warehouse_id    = p_warehouse_id;

  INSERT INTO public.stock_reservations
    (organization_id, business_id, branch_id, warehouse_id, product_id, lot_id,
     quantity, source_type, source_id, reserved_by, expires_at)
  VALUES
    (p_organization_id, v_wh.business_id, v_wh.branch_id, p_warehouse_id, p_product_id, p_lot_id,
     p_quantity, p_source_type, p_source_id, auth.uid(), p_expires_at)
  RETURNING id INTO v_reservation_id;

  RETURN jsonb_build_object(
    'success', true,
    'reservation_id', v_reservation_id,
    'reserved', p_quantity,
    'available', v_available - p_quantity
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.release_stock_reservation(
  p_organization_id UUID,
  p_reservation_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_res RECORD;
BEGIN
  SELECT * INTO v_res
    FROM public.stock_reservations
   WHERE id = p_reservation_id
     AND organization_id = p_organization_id
     AND released_at IS NULL
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Reservation not found or already released');
  END IF;

  UPDATE public.warehouse_stock
     SET reserved_quantity = GREATEST(COALESCE(reserved_quantity, 0) - v_res.quantity, 0),
         updated_at = now()
   WHERE organization_id = p_organization_id
     AND business_id     = v_res.business_id
     AND product_id      = v_res.product_id
     AND warehouse_id    = v_res.warehouse_id;

  UPDATE public.stock_reservations
     SET released_at = now()
   WHERE id = p_reservation_id;

  RETURN jsonb_build_object('success', true, 'released', v_res.quantity);
END;
$$;

CREATE OR REPLACE FUNCTION public.expire_stock_reservations()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INTEGER := 0;
  r RECORD;
BEGIN
  FOR r IN
    SELECT id, organization_id, business_id, warehouse_id, product_id, quantity
      FROM public.stock_reservations
     WHERE released_at IS NULL
       AND expires_at IS NOT NULL
       AND expires_at < now()
     FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE public.warehouse_stock
       SET reserved_quantity = GREATEST(COALESCE(reserved_quantity, 0) - r.quantity, 0),
           updated_at = now()
     WHERE organization_id = r.organization_id
       AND business_id     = r.business_id
       AND product_id      = r.product_id
       AND warehouse_id    = r.warehouse_id;

    UPDATE public.stock_reservations
       SET released_at = now()
     WHERE id = r.id;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_stock_reservation(UUID, UUID, UUID, NUMERIC, TEXT, UUID, TIMESTAMPTZ, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.release_stock_reservation(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.expire_stock_reservations() TO authenticated;

COMMENT ON TABLE public.stock_lots IS
  'Phase 5: Lot/serial master. Per ADR 0001, lot enforcement is deferred — '
  'this table is provisioned but not yet populated by goods receipt flows.';

COMMENT ON TABLE public.warehouse_stock_lots IS
  'Phase 5: Per-lot quantity per warehouse (Odoo-style "quant"). '
  'Empty until lot-enforced receiving is enabled in a future migration. '
  'Sum of (quantity) per (business_id, warehouse_id, product_id) must equal '
  'warehouse_stock.quantity once enabled.';

COMMENT ON TABLE public.stock_reservations IS
  'Phase 5: Unified reservation primitive. Supersedes pos_stock_reservations. '
  'Source-typed: pos (expiring, register-driven), sales_order (open until '
  'delivery/cancel), transfer (until receipt), manual.';
