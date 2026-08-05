-- ============================================================
-- Phase 1 — close the drift
-- ============================================================
-- The 4-arg overload made every PostgREST call ambiguous (PGRST203 / HTTP 300).
DROP FUNCTION IF EXISTS public.enroll_product_barcode(uuid, uuid, text, public.product_identifier_kind);

REVOKE ALL ON FUNCTION public.resolve_product_identity(uuid, text, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.product_identification_queue(uuid, text, integer, integer) FROM anon;
REVOKE ALL ON FUNCTION public.enroll_product_barcode(uuid, uuid, text, public.product_identifier_kind, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.resolve_product_identity(uuid, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.product_identification_queue(uuid, text, integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.enroll_product_barcode(uuid, uuid, text, public.product_identifier_kind, uuid) TO authenticated;

-- ============================================================
-- Phase 2 — identity becomes a first-class entity
-- ============================================================
DO $$ BEGIN
  CREATE TYPE public.product_identifier_status AS ENUM ('active', 'inactive', 'archived');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.product_identifier_source AS ENUM ('manual', 'import', 'asn', 'gs1', 'migration', 'pos');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE public.product_identifiers
  ADD COLUMN IF NOT EXISTS status public.product_identifier_status NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS valid_from timestamptz,
  ADD COLUMN IF NOT EXISTS valid_to timestamptz,
  ADD COLUMN IF NOT EXISTS source public.product_identifier_source NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS supplier_id uuid REFERENCES public.suppliers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS replaced_by_id uuid REFERENCES public.product_identifiers(id) ON DELETE SET NULL;

-- A supplier code must say WHOSE code it is; every other kind must not.
CREATE OR REPLACE FUNCTION public._product_identifier_lifecycle_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.kind <> 'supplier' THEN
    NEW.supplier_id := NULL;
  END IF;
  IF NEW.valid_from IS NOT NULL AND NEW.valid_to IS NOT NULL AND NEW.valid_to <= NEW.valid_from THEN
    RAISE EXCEPTION 'product_identifiers.valid_to must be after valid_from';
  END IF;
  -- Only an active identifier can be primary.
  IF NEW.status <> 'active' THEN
    NEW.is_primary := false;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_product_identifier_lifecycle ON public.product_identifiers;
CREATE TRIGGER trg_product_identifier_lifecycle
  BEFORE INSERT OR UPDATE ON public.product_identifiers
  FOR EACH ROW EXECUTE FUNCTION public._product_identifier_lifecycle_guard();

-- Uniqueness now applies to LIVE codes only, so an archived code can be re-issued.
DROP INDEX IF EXISTS public.product_identifiers_business_code_norm_key;
DROP INDEX IF EXISTS public.product_identifiers_business_code_norm_kind_key;
CREATE UNIQUE INDEX IF NOT EXISTS product_identifiers_active_business_code_uidx
  ON public.product_identifiers (business_id, code_norm)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS product_identifiers_supplier_idx
  ON public.product_identifiers (supplier_id) WHERE supplier_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS product_identifiers_lookup_idx
  ON public.product_identifiers (business_id, code_norm, status);