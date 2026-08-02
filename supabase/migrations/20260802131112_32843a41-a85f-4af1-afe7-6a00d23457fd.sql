-- =====================================================================
-- ADR 0105 — Packaging Master, Phase 1 (data model)
-- =====================================================================

DO $$ BEGIN
  CREATE TYPE public.wms_packaging_class AS ENUM
    ('carton','envelope','tube','crate','pallet','tote','insulated','drum','bag');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.wms_packaging_lifecycle AS ENUM
    ('draft','active','restricted','retired');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------
-- 1) wms_packaging_types
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.wms_packaging_types (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NULL,
  business_id           uuid NOT NULL,
  code                  text NOT NULL,
  name                  text NOT NULL,
  packaging_class       public.wms_packaging_class NOT NULL DEFAULT 'carton',
  material              text NULL,

  -- geometry: inner = usable cavity, outer = shipped footprint
  inner_length_cm       numeric NOT NULL CHECK (inner_length_cm > 0),
  inner_width_cm        numeric NOT NULL CHECK (inner_width_cm  > 0),
  inner_height_cm       numeric NOT NULL CHECK (inner_height_cm > 0),
  outer_length_cm       numeric NULL CHECK (outer_length_cm > 0),
  outer_width_cm        numeric NULL CHECK (outer_width_cm  > 0),
  outer_height_cm       numeric NULL CHECK (outer_height_cm > 0),

  -- capability
  max_weight_kg         numeric NOT NULL DEFAULT 30 CHECK (max_weight_kg > 0),
  tare_weight_kg        numeric NOT NULL DEFAULT 0  CHECK (tare_weight_kg >= 0),
  max_volume_fill_pct   numeric NOT NULL DEFAULT 85
                          CHECK (max_volume_fill_pct > 0 AND max_volume_fill_pct <= 100),
  dim_weight_divisor    numeric NULL CHECK (dim_weight_divisor > 0),
  is_returnable         boolean NOT NULL DEFAULT false,
  is_stackable          boolean NOT NULL DEFAULT true,
  nest_ratio            numeric NULL CHECK (nest_ratio > 0),
  units_per_layer       integer NULL CHECK (units_per_layer > 0),
  layers_per_unit       integer NULL CHECK (layers_per_unit > 0),
  hazmat_class          text NULL,
  un_rating             text NULL,
  temp_min_c            numeric NULL,
  temp_max_c            numeric NULL,

  -- commercial / lifecycle
  cost                  numeric(15,4) NOT NULL DEFAULT 0 CHECK (cost >= 0),
  lifecycle_status      public.wms_packaging_lifecycle NOT NULL DEFAULT 'active',
  notes                 text NULL,

  row_version           integer NOT NULL DEFAULT 1,
  created_by            uuid NULL,
  updated_by            uuid NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT wms_packaging_types_unique_code UNIQUE (business_id, code),
  CONSTRAINT wms_packaging_types_temp_band CHECK (
    temp_min_c IS NULL OR temp_max_c IS NULL OR temp_min_c <= temp_max_c),
  CONSTRAINT wms_packaging_types_outer_ge_inner CHECK (
    (outer_length_cm IS NULL OR outer_length_cm >= inner_length_cm) AND
    (outer_width_cm  IS NULL OR outer_width_cm  >= inner_width_cm)  AND
    (outer_height_cm IS NULL OR outer_height_cm >= inner_height_cm))
);

CREATE INDEX IF NOT EXISTS idx_wms_packaging_types_business
  ON public.wms_packaging_types (business_id, lifecycle_status);
CREATE INDEX IF NOT EXISTS idx_wms_packaging_types_class
  ON public.wms_packaging_types (business_id, packaging_class);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.wms_packaging_types TO authenticated;
GRANT ALL ON public.wms_packaging_types TO service_role;

ALTER TABLE public.wms_packaging_types ENABLE ROW LEVEL SECURITY;

CREATE POLICY wms_packaging_types_select ON public.wms_packaging_types
  FOR SELECT TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id));

CREATE POLICY wms_packaging_types_write ON public.wms_packaging_types
  FOR ALL TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id)
         AND public.user_has_module_permission(auth.uid(), business_id, 'inventory', 'write'))
  WITH CHECK (public.user_can_access_business(auth.uid(), business_id)
              AND public.user_has_module_permission(auth.uid(), business_id, 'inventory', 'write'));

CREATE OR REPLACE FUNCTION public._touch_wms_packaging_types()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  NEW.updated_at := now();
  IF NEW.row_version = OLD.row_version THEN
    NEW.row_version := OLD.row_version + 1;
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_wms_packaging_types_touch ON public.wms_packaging_types;
CREATE TRIGGER trg_wms_packaging_types_touch
  BEFORE UPDATE ON public.wms_packaging_types
  FOR EACH ROW EXECUTE FUNCTION public._touch_wms_packaging_types();

-- ---------------------------------------------------------------------
-- 2) wms_packaging_carriers — admissibility matrix
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.wms_packaging_carriers (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         uuid NOT NULL,
  packaging_type_id   uuid NOT NULL REFERENCES public.wms_packaging_types(id) ON DELETE CASCADE,
  carrier_id          uuid NOT NULL REFERENCES public.carriers(id) ON DELETE CASCADE,
  service_code        text NULL,
  is_allowed          boolean NOT NULL DEFAULT true,
  is_oversize         boolean NOT NULL DEFAULT false,
  surcharge_amount    numeric(15,4) NOT NULL DEFAULT 0 CHECK (surcharge_amount >= 0),
  dim_weight_divisor  numeric NULL CHECK (dim_weight_divisor > 0),
  notes               text NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wms_packaging_carriers_unique
    UNIQUE (packaging_type_id, carrier_id, service_code)
);

CREATE INDEX IF NOT EXISTS idx_wms_packaging_carriers_pkg
  ON public.wms_packaging_carriers (packaging_type_id);
CREATE INDEX IF NOT EXISTS idx_wms_packaging_carriers_carrier
  ON public.wms_packaging_carriers (carrier_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.wms_packaging_carriers TO authenticated;
GRANT ALL ON public.wms_packaging_carriers TO service_role;

ALTER TABLE public.wms_packaging_carriers ENABLE ROW LEVEL SECURITY;

CREATE POLICY wms_packaging_carriers_select ON public.wms_packaging_carriers
  FOR SELECT TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id));

CREATE POLICY wms_packaging_carriers_write ON public.wms_packaging_carriers
  FOR ALL TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id)
         AND public.user_has_module_permission(auth.uid(), business_id, 'inventory', 'write'))
  WITH CHECK (public.user_can_access_business(auth.uid(), business_id)
              AND public.user_has_module_permission(auth.uid(), business_id, 'inventory', 'write'));

DROP TRIGGER IF EXISTS trg_wms_packaging_carriers_updated_at ON public.wms_packaging_carriers;
CREATE TRIGGER trg_wms_packaging_carriers_updated_at
  BEFORE UPDATE ON public.wms_packaging_carriers
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ---------------------------------------------------------------------
-- 3) wms_packaging_availability — packaging supply per warehouse
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.wms_packaging_availability (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         uuid NOT NULL,
  warehouse_id        uuid NOT NULL,
  packaging_type_id   uuid NOT NULL REFERENCES public.wms_packaging_types(id) ON DELETE CASCADE,
  is_stocked          boolean NOT NULL DEFAULT true,
  qty_on_hand         numeric NOT NULL DEFAULT 0 CHECK (qty_on_hand >= 0),
  reorder_point       numeric NOT NULL DEFAULT 0 CHECK (reorder_point >= 0),
  last_counted_at     timestamptz NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wms_packaging_availability_unique UNIQUE (packaging_type_id, warehouse_id)
);

CREATE INDEX IF NOT EXISTS idx_wms_packaging_availability_wh
  ON public.wms_packaging_availability (business_id, warehouse_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.wms_packaging_availability TO authenticated;
GRANT ALL ON public.wms_packaging_availability TO service_role;

ALTER TABLE public.wms_packaging_availability ENABLE ROW LEVEL SECURITY;

CREATE POLICY wms_packaging_availability_select ON public.wms_packaging_availability
  FOR SELECT TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id));

CREATE POLICY wms_packaging_availability_write ON public.wms_packaging_availability
  FOR ALL TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id)
         AND public.user_has_module_permission(auth.uid(), business_id, 'inventory', 'write'))
  WITH CHECK (public.user_can_access_business(auth.uid(), business_id)
              AND public.user_has_module_permission(auth.uid(), business_id, 'inventory', 'write'));

DROP TRIGGER IF EXISTS trg_wms_packaging_availability_updated_at ON public.wms_packaging_availability;
CREATE TRIGGER trg_wms_packaging_availability_updated_at
  BEFORE UPDATE ON public.wms_packaging_availability
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ---------------------------------------------------------------------
-- 4) wms_packaging_events — append-only audit ledger
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.wms_packaging_events (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         uuid NOT NULL,
  packaging_type_id   uuid NOT NULL REFERENCES public.wms_packaging_types(id) ON DELETE CASCADE,
  event_type          text NOT NULL,
  from_status         public.wms_packaging_lifecycle NULL,
  to_status           public.wms_packaging_lifecycle NULL,
  warehouse_id        uuid NULL,
  qty_delta           numeric NULL,
  reason              text NULL,
  payload             jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_id            uuid NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wms_packaging_events_pkg
  ON public.wms_packaging_events (packaging_type_id, created_at DESC);

GRANT SELECT ON public.wms_packaging_events TO authenticated;
GRANT ALL ON public.wms_packaging_events TO service_role;

ALTER TABLE public.wms_packaging_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY wms_packaging_events_select ON public.wms_packaging_events
  FOR SELECT TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id));

-- ---------------------------------------------------------------------
-- 5) Migrate legacy carton catalogue rows (ids preserved)
-- ---------------------------------------------------------------------
INSERT INTO public.wms_packaging_types (
  id, business_id, code, name, packaging_class,
  inner_length_cm, inner_width_cm, inner_height_cm,
  max_weight_kg, tare_weight_kg, cost,
  lifecycle_status, notes, created_by, created_at, updated_at
)
SELECT c.id, c.business_id, c.code, c.name, 'carton'::public.wms_packaging_class,
       c.length_cm, c.width_cm, c.height_cm,
       c.max_weight_kg, c.tare_weight_kg, c.cost,
       CASE WHEN c.is_active THEN 'active' ELSE 'retired' END::public.wms_packaging_lifecycle,
       c.notes, c.created_by, c.created_at, c.updated_at
  FROM public.wms_carton_types c
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------
-- 6) Packing history references the packaging master
-- ---------------------------------------------------------------------
ALTER TABLE public.wms_pack_cartons
  ADD COLUMN IF NOT EXISTS packaging_type_id uuid NULL
    REFERENCES public.wms_packaging_types(id) ON DELETE RESTRICT;

UPDATE public.wms_pack_cartons
   SET packaging_type_id = carton_type_id
 WHERE carton_type_id IS NOT NULL
   AND packaging_type_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_wms_pack_cartons_packaging_type
  ON public.wms_pack_cartons (packaging_type_id);