DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
                 WHERE n.nspname='public' AND t.typname='product_lifecycle_status') THEN
    CREATE TYPE public.product_lifecycle_status AS ENUM ('draft','active','discontinued','archived');
  END IF;
END $$;

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS status public.product_lifecycle_status NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS archived_by uuid,
  ADD COLUMN IF NOT EXISTS lifecycle_reason text;

COMMENT ON COLUMN public.products.status IS 'Authoritative lifecycle state. is_active is derived from it (status = active).';
COMMENT ON COLUMN public.products.is_active IS 'DERIVED from status by trg_enforce_product_lifecycle. Kept for legacy readers; do not treat as the source of truth.';

UPDATE public.products SET status = 'discontinued'
 WHERE is_active IS FALSE AND status = 'active';

CREATE OR REPLACE FUNCTION public._enforce_product_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_allowed text[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status IS NULL THEN
      NEW.status := CASE WHEN NEW.is_active IS FALSE THEN 'discontinued' ELSE 'active' END;
    ELSIF NEW.status = 'active' AND NEW.is_active IS FALSE THEN
      -- legacy writer only knows is_active
      NEW.status := 'discontinued';
    END IF;
  ELSE
    IF NEW.status = OLD.status
       AND coalesce(NEW.is_active, true) IS DISTINCT FROM coalesce(OLD.is_active, true) THEN
      -- legacy writer flipped is_active: translate it into a lifecycle change
      NEW.status := CASE WHEN NEW.is_active IS FALSE THEN 'discontinued' ELSE 'active' END;
    END IF;

    IF NEW.status IS DISTINCT FROM OLD.status THEN
      v_allowed := CASE OLD.status
        WHEN 'draft'        THEN ARRAY['active','archived']
        WHEN 'active'       THEN ARRAY['discontinued','archived']
        WHEN 'discontinued' THEN ARRAY['active','archived']
        WHEN 'archived'     THEN ARRAY['active','discontinued']
      END;
      IF NOT (NEW.status::text = ANY (v_allowed)) THEN
        RAISE EXCEPTION 'PRODUCT_LIFECYCLE_TRANSITION: cannot move product from % to %', OLD.status, NEW.status
          USING ERRCODE = 'P0001';
      END IF;
    END IF;
  END IF;

  IF NEW.status = 'archived'
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'archived')
     AND coalesce(NEW.stock_quantity, 0) <> 0 THEN
    RAISE EXCEPTION 'PRODUCT_ARCHIVE_HAS_STOCK: product still holds % on hand; move or write it off before archiving', NEW.stock_quantity
      USING ERRCODE = 'P0001';
  END IF;

  NEW.is_active := (NEW.status = 'active');

  IF NEW.status = 'archived' THEN
    NEW.archived_at := coalesce(NEW.archived_at, now());
    NEW.archived_by := coalesce(NEW.archived_by, auth.uid());
  ELSE
    NEW.archived_at := NULL;
    NEW.archived_by := NULL;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_product_lifecycle ON public.products;
CREATE TRIGGER trg_enforce_product_lifecycle
BEFORE INSERT OR UPDATE ON public.products
FOR EACH ROW EXECUTE FUNCTION public._enforce_product_lifecycle();

CREATE INDEX IF NOT EXISTS idx_products_business_status
  ON public.products (business_id, status);

-- Archived products may not move stock on any path
CREATE OR REPLACE FUNCTION public._reject_archived_product_movement()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status public.product_lifecycle_status;
BEGIN
  IF NEW.product_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT status INTO v_status FROM public.products WHERE id = NEW.product_id;
  IF v_status = 'archived' THEN
    RAISE EXCEPTION 'PRODUCT_ARCHIVED: product % is archived and cannot receive stock movements', NEW.product_id
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_reject_archived_product_movement ON public.stock_movements;
CREATE TRIGGER trg_reject_archived_product_movement
BEFORE INSERT ON public.stock_movements
FOR EACH ROW EXECUTE FUNCTION public._reject_archived_product_movement();

CREATE OR REPLACE FUNCTION public.set_product_lifecycle_status(
  p_product_id uuid,
  p_status text,
  p_reason text DEFAULT NULL
)
RETURNS public.products
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid;
  v_row public.products;
BEGIN
  SELECT organization_id INTO v_org FROM public.products WHERE id = p_product_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'PRODUCT_NOT_FOUND: product does not exist' USING ERRCODE = 'P0001';
  END IF;
  PERFORM public._assert_org_member(v_org);

  IF p_status IS NULL OR NOT (p_status = ANY (ARRAY['draft','active','discontinued','archived'])) THEN
    RAISE EXCEPTION 'PRODUCT_LIFECYCLE_STATUS_INVALID: % is not a lifecycle state', p_status
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.products
     SET status = p_status::public.product_lifecycle_status,
         lifecycle_reason = nullif(btrim(coalesce(p_reason,'')), ''),
         updated_at = now()
   WHERE id = p_product_id
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.set_product_lifecycle_status(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_product_lifecycle_status(uuid, text, text) TO authenticated, service_role;