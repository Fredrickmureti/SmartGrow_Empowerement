-- =========================================================================
-- Returns Phase 1 — domain model completion (additive)
-- =========================================================================

-- 1) Enums --------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE public.wms_return_kind AS ENUM
    ('customer','vendor','internal','transfer');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.wms_return_condition AS ENUM
    ('unopened','opened','damaged','defective','expired','missing_accessories','incorrect_item');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.wms_return_line_inspection_state AS ENUM
    ('pending','inspecting','passed','failed','conditional','waived');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Extend the disposition enum with the dispositions the target flow needs.
DO $$ BEGIN
  ALTER TYPE public.wms_return_disposition ADD VALUE IF NOT EXISTS 'quarantine';
EXCEPTION WHEN others THEN NULL; END $$;
DO $$ BEGIN
  ALTER TYPE public.wms_return_disposition ADD VALUE IF NOT EXISTS 'refurbish';
EXCEPTION WHEN others THEN NULL; END $$;
DO $$ BEGIN
  ALTER TYPE public.wms_return_disposition ADD VALUE IF NOT EXISTS 'quality_hold';
EXCEPTION WHEN others THEN NULL; END $$;

-- 2) wms_return_orders --------------------------------------------------
ALTER TABLE public.wms_return_orders
  ADD COLUMN IF NOT EXISTS return_kind public.wms_return_kind NOT NULL DEFAULT 'customer',
  ADD COLUMN IF NOT EXISTS appointment_id UUID REFERENCES public.wms_dock_appointments(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS dock_id UUID,
  ADD COLUMN IF NOT EXISTS trailer_visit_id UUID REFERENCES public.wms_trailer_visits(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS carrier_id UUID,
  ADD COLUMN IF NOT EXISTS tracking_reference TEXT,
  ADD COLUMN IF NOT EXISTS finance_doc_type TEXT,
  ADD COLUMN IF NOT EXISTS finance_doc_id UUID,
  ADD COLUMN IF NOT EXISTS credit_note_id UUID,
  ADD COLUMN IF NOT EXISTS disposition_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS posted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_wms_return_orders_state
  ON public.wms_return_orders (business_id, warehouse_id, state);
CREATE INDEX IF NOT EXISTS idx_wms_return_orders_appointment
  ON public.wms_return_orders (appointment_id) WHERE appointment_id IS NOT NULL;

-- 3) wms_return_lines ---------------------------------------------------
ALTER TABLE public.wms_return_lines
  ADD COLUMN IF NOT EXISTS uom TEXT,
  ADD COLUMN IF NOT EXISTS condition_code public.wms_return_condition,
  ADD COLUMN IF NOT EXISTS inspection_state public.wms_return_line_inspection_state NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS inspected_by UUID,
  ADD COLUMN IF NOT EXISTS inspected_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS captured_by UUID,
  ADD COLUMN IF NOT EXISTS captured_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS restock_qty NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS scrap_qty NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS quarantine_qty NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lpn_out_id UUID REFERENCES public.wms_license_plates(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS photo_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS dispositioned_by UUID,
  ADD COLUMN IF NOT EXISTS dispositioned_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS posted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS blocked_reason TEXT,
  ADD COLUMN IF NOT EXISTS row_version INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_wms_return_lines_order
  ON public.wms_return_lines (return_order_id);
CREATE INDEX IF NOT EXISTS idx_wms_return_lines_inspection
  ON public.wms_return_lines (return_order_id, inspection_state);

-- 4) wms_return_photos --------------------------------------------------
CREATE TABLE IF NOT EXISTS public.wms_return_photos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  return_line_id UUID NOT NULL REFERENCES public.wms_return_lines(id) ON DELETE CASCADE,
  return_order_id UUID NOT NULL REFERENCES public.wms_return_orders(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL,
  business_id UUID NOT NULL,
  storage_bucket TEXT NOT NULL DEFAULT 'documents',
  storage_path TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'condition',
  caption TEXT,
  captured_by UUID,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.wms_return_photos TO authenticated;
GRANT ALL ON public.wms_return_photos TO service_role;
ALTER TABLE public.wms_return_photos ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "wms_return_photos rw" ON public.wms_return_photos;
CREATE POLICY "wms_return_photos rw" ON public.wms_return_photos FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.wms_return_orders o WHERE o.id = wms_return_photos.return_order_id))
  WITH CHECK (EXISTS (SELECT 1 FROM public.wms_return_orders o WHERE o.id = wms_return_photos.return_order_id));
CREATE INDEX IF NOT EXISTS idx_wms_return_photos_line
  ON public.wms_return_photos (return_line_id);

-- 5) wms_return_disposition_rules --------------------------------------
CREATE TABLE IF NOT EXISTS public.wms_return_disposition_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  business_id UUID NOT NULL,
  warehouse_id UUID REFERENCES public.warehouses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  return_kind public.wms_return_kind,
  condition_code public.wms_return_condition,
  product_id UUID,
  category_id UUID,
  customer_id UUID,
  disposition public.wms_return_disposition NOT NULL,
  destination_location_id UUID REFERENCES public.stock_locations(id) ON DELETE SET NULL,
  requires_inspection BOOLEAN NOT NULL DEFAULT true,
  priority INTEGER NOT NULL DEFAULT 100,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.wms_return_disposition_rules TO authenticated;
GRANT ALL ON public.wms_return_disposition_rules TO service_role;
ALTER TABLE public.wms_return_disposition_rules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "wms_return_disposition_rules rw" ON public.wms_return_disposition_rules;
CREATE POLICY "wms_return_disposition_rules rw" ON public.wms_return_disposition_rules FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.businesses b WHERE b.id = wms_return_disposition_rules.business_id))
  WITH CHECK (EXISTS (SELECT 1 FROM public.businesses b WHERE b.id = wms_return_disposition_rules.business_id));
CREATE INDEX IF NOT EXISTS idx_wms_return_disp_rules_lookup
  ON public.wms_return_disposition_rules (business_id, is_active, priority);

-- 6) updated_at triggers ------------------------------------------------
DROP TRIGGER IF EXISTS trg_wms_return_photos_touch ON public.wms_return_photos;
CREATE TRIGGER trg_wms_return_photos_touch
  BEFORE UPDATE ON public.wms_return_photos
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS trg_wms_return_disp_rules_touch ON public.wms_return_disposition_rules;
CREATE TRIGGER trg_wms_return_disp_rules_touch
  BEFORE UPDATE ON public.wms_return_disposition_rules
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();