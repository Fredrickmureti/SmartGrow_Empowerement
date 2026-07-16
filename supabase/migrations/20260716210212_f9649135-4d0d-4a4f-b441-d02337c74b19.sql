-- =====================================================================
-- ADR-0064 Phase 1 — additive: stock_locations + stock_quants
-- =====================================================================

DO $$ BEGIN
  CREATE TYPE public.stock_location_type AS ENUM (
    'internal', 'quarantine', 'staging', 'transit',
    'customer', 'vendor', 'scrap', 'production', 'view'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.stock_location_usage AS ENUM (
    'storage', 'pick', 'pack', 'ship', 'receive', 'inspection', 'virtual'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.stock_locations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL,
  business_id         uuid NOT NULL,
  branch_id           uuid,
  warehouse_id        uuid NOT NULL REFERENCES public.warehouses(id) ON DELETE RESTRICT,
  parent_location_id  uuid REFERENCES public.stock_locations(id) ON DELETE RESTRICT,
  code                text NOT NULL,
  name                text NOT NULL,
  location_type       public.stock_location_type NOT NULL DEFAULT 'internal',
  usage               public.stock_location_usage NOT NULL DEFAULT 'storage',
  is_active           boolean NOT NULL DEFAULT true,
  is_default          boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid,
  UNIQUE (warehouse_id, code)
);

CREATE UNIQUE INDEX IF NOT EXISTS stock_locations_one_default_per_warehouse
  ON public.stock_locations (warehouse_id) WHERE is_default = true;
CREATE INDEX IF NOT EXISTS stock_locations_warehouse_active_idx
  ON public.stock_locations (warehouse_id) WHERE is_active;
CREATE INDEX IF NOT EXISTS stock_locations_parent_idx
  ON public.stock_locations (parent_location_id);
CREATE INDEX IF NOT EXISTS stock_locations_business_idx
  ON public.stock_locations (business_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.stock_locations TO authenticated;
GRANT ALL ON public.stock_locations TO service_role;
ALTER TABLE public.stock_locations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "stock_locations_select" ON public.stock_locations FOR SELECT TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id)
         AND (branch_id IS NULL OR public.can_access_branch(auth.uid(), branch_id)));

CREATE POLICY "stock_locations_insert" ON public.stock_locations FOR INSERT TO authenticated
  WITH CHECK (public.user_can_access_business(auth.uid(), business_id)
              AND (branch_id IS NULL OR public.can_access_branch(auth.uid(), branch_id))
              AND public.user_has_module_permission(auth.uid(), business_id, 'inventory', 'write'));

CREATE POLICY "stock_locations_update" ON public.stock_locations FOR UPDATE TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id)
         AND (branch_id IS NULL OR public.can_access_branch(auth.uid(), branch_id))
         AND public.user_has_module_permission(auth.uid(), business_id, 'inventory', 'write'))
  WITH CHECK (public.user_can_access_business(auth.uid(), business_id)
              AND (branch_id IS NULL OR public.can_access_branch(auth.uid(), branch_id)));

CREATE POLICY "stock_locations_delete" ON public.stock_locations FOR DELETE TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id)
         AND (branch_id IS NULL OR public.can_access_branch(auth.uid(), branch_id))
         AND public.user_has_module_permission(auth.uid(), business_id, 'inventory', 'delete')
         AND is_default = false);

CREATE OR REPLACE FUNCTION public._touch_stock_locations_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS trg_stock_locations_touch ON public.stock_locations;
CREATE TRIGGER trg_stock_locations_touch
  BEFORE UPDATE ON public.stock_locations
  FOR EACH ROW EXECUTE FUNCTION public._touch_stock_locations_updated_at();

-- Seed default location per existing warehouse
INSERT INTO public.stock_locations
  (organization_id, business_id, branch_id, warehouse_id, code, name,
   location_type, usage, is_default)
SELECT w.organization_id, w.business_id, w.branch_id, w.id,
       'STOCK', 'Stock', 'internal', 'storage', true
FROM public.warehouses w
WHERE NOT EXISTS (
  SELECT 1 FROM public.stock_locations sl
  WHERE sl.warehouse_id = w.id AND sl.is_default
);

-- stock_quants -------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.stock_quants (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL,
  business_id         uuid NOT NULL,
  branch_id           uuid,
  product_id          uuid NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  location_id         uuid NOT NULL REFERENCES public.stock_locations(id) ON DELETE RESTRICT,
  lot_number          text,
  package_id          uuid REFERENCES public.product_packaging(id) ON DELETE RESTRICT,
  owner_id            uuid,
  quantity            numeric NOT NULL DEFAULT 0,
  reserved_quantity   numeric NOT NULL DEFAULT 0,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS stock_quants_identity_uidx
  ON public.stock_quants (
    product_id, location_id,
    COALESCE(lot_number, ''),
    COALESCE(package_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(owner_id,   '00000000-0000-0000-0000-000000000000'::uuid)
  );

CREATE INDEX IF NOT EXISTS stock_quants_location_idx  ON public.stock_quants (location_id);
CREATE INDEX IF NOT EXISTS stock_quants_product_idx   ON public.stock_quants (product_id);
CREATE INDEX IF NOT EXISTS stock_quants_business_idx  ON public.stock_quants (business_id);
CREATE INDEX IF NOT EXISTS stock_quants_lot_idx
  ON public.stock_quants (product_id, lot_number) WHERE lot_number IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.stock_quants TO authenticated;
GRANT ALL ON public.stock_quants TO service_role;
ALTER TABLE public.stock_quants ENABLE ROW LEVEL SECURITY;

CREATE POLICY "stock_quants_select" ON public.stock_quants FOR SELECT TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id)
         AND (branch_id IS NULL OR public.can_access_branch(auth.uid(), branch_id)));

CREATE POLICY "stock_quants_write" ON public.stock_quants FOR ALL TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id)
         AND (branch_id IS NULL OR public.can_access_branch(auth.uid(), branch_id))
         AND public.user_has_module_permission(auth.uid(), business_id, 'inventory', 'write'))
  WITH CHECK (public.user_can_access_business(auth.uid(), business_id)
              AND (branch_id IS NULL OR public.can_access_branch(auth.uid(), branch_id))
              AND public.user_has_module_permission(auth.uid(), business_id, 'inventory', 'write'));

CREATE OR REPLACE FUNCTION public._touch_stock_quants_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS trg_stock_quants_touch ON public.stock_quants;
CREATE TRIGGER trg_stock_quants_touch
  BEFORE UPDATE ON public.stock_quants
  FOR EACH ROW EXECUTE FUNCTION public._touch_stock_quants_updated_at();

-- Backfill per-lot balances via stock_lots.lot_number
INSERT INTO public.stock_quants
  (organization_id, business_id, branch_id, product_id, location_id,
   lot_number, quantity, reserved_quantity)
SELECT
  w.organization_id, w.business_id, w.branch_id,
  wsl.product_id, sl.id,
  lot.lot_number, wsl.quantity, COALESCE(wsl.reserved_quantity, 0)
FROM public.warehouse_stock_lots wsl
JOIN public.warehouses w ON w.id = wsl.warehouse_id
JOIN public.stock_lots  lot ON lot.id = wsl.lot_id
JOIN public.stock_locations sl
  ON sl.warehouse_id = wsl.warehouse_id AND sl.is_default
ON CONFLICT DO NOTHING;

-- Seed remainder (non-lot-tracked or unaccounted) as NULL lot rows
INSERT INTO public.stock_quants
  (organization_id, business_id, branch_id, product_id, location_id,
   lot_number, quantity, reserved_quantity)
SELECT
  w.organization_id, w.business_id, w.branch_id,
  ws.product_id, sl.id,
  NULL::text,
  ws.quantity - COALESCE((
    SELECT SUM(wsl.quantity) FROM public.warehouse_stock_lots wsl
    WHERE wsl.warehouse_id = ws.warehouse_id
      AND wsl.product_id  = ws.product_id
  ), 0),
  COALESCE(ws.reserved_quantity, 0)
FROM public.warehouse_stock ws
JOIN public.warehouses w ON w.id = ws.warehouse_id
JOIN public.stock_locations sl
  ON sl.warehouse_id = ws.warehouse_id AND sl.is_default
WHERE (ws.quantity - COALESCE((
  SELECT SUM(wsl.quantity) FROM public.warehouse_stock_lots wsl
  WHERE wsl.warehouse_id = ws.warehouse_id AND wsl.product_id = ws.product_id
), 0)) <> 0
ON CONFLICT DO NOTHING;

-- Shadow sync trigger ------------------------------------------------
CREATE OR REPLACE FUNCTION public._maintain_stock_quants()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_location_id uuid;
BEGIN
  IF NEW.warehouse_id IS NULL OR NEW.quantity = 0 THEN
    RETURN NEW;
  END IF;

  SELECT id INTO v_location_id
  FROM public.stock_locations
  WHERE warehouse_id = NEW.warehouse_id AND is_default
  LIMIT 1;

  IF v_location_id IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.stock_quants AS q
    (organization_id, business_id, branch_id,
     product_id, location_id, lot_number, quantity)
  VALUES
    (NEW.organization_id, NEW.business_id, NEW.branch_id,
     NEW.product_id, v_location_id, NEW.lot_number, NEW.quantity)
  ON CONFLICT (
    product_id, location_id,
    COALESCE(lot_number, ''),
    COALESCE(package_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(owner_id,   '00000000-0000-0000-0000-000000000000'::uuid)
  )
  DO UPDATE SET
    quantity   = q.quantity + EXCLUDED.quantity,
    updated_at = now();

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_maintain_stock_quants ON public.stock_movements;
CREATE TRIGGER trg_maintain_stock_quants
  AFTER INSERT ON public.stock_movements
  FOR EACH ROW EXECUTE FUNCTION public._maintain_stock_quants();

-- Drift view ---------------------------------------------------------
CREATE OR REPLACE VIEW public.stock_quant_drift_view AS
SELECT
  ws.warehouse_id,
  ws.product_id,
  ws.quantity                                    AS warehouse_stock_qty,
  COALESCE(SUM(sq.quantity), 0)                  AS quant_qty,
  ws.quantity - COALESCE(SUM(sq.quantity), 0)    AS drift
FROM public.warehouse_stock ws
LEFT JOIN public.stock_locations sl
  ON sl.warehouse_id = ws.warehouse_id AND sl.is_default
LEFT JOIN public.stock_quants sq
  ON sq.location_id = sl.id AND sq.product_id = ws.product_id
GROUP BY ws.warehouse_id, ws.product_id, ws.quantity
HAVING ws.quantity - COALESCE(SUM(sq.quantity), 0) <> 0;

GRANT SELECT ON public.stock_quant_drift_view TO authenticated;
