-- Phase A: Odoo-grade additive schema upgrade for contacts

-- 1. Add new columns
ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS parent_contact_id uuid NULL REFERENCES public.contacts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS is_company boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS child_address_type text NULL,
  ADD COLUMN IF NOT EXISTS customer_rank integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS supplier_rank integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS commercial_partner_id uuid NULL REFERENCES public.contacts(id) ON DELETE SET NULL;

-- 2. Constraint on child_address_type
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'contacts_child_address_type_check'
  ) THEN
    ALTER TABLE public.contacts
      ADD CONSTRAINT contacts_child_address_type_check
      CHECK (child_address_type IS NULL OR child_address_type IN ('contact','invoice','delivery','other'));
  END IF;
END$$;

-- 3. Backfill ranks from legacy `type` enum
UPDATE public.contacts
SET customer_rank = CASE WHEN type::text IN ('customer','both') THEN 1 ELSE 0 END,
    supplier_rank = CASE WHEN type::text IN ('supplier','both') THEN 1 ELSE 0 END
WHERE customer_rank = 0 AND supplier_rank = 0;

-- 4. Backfill is_company from non-empty company text
UPDATE public.contacts
SET is_company = true
WHERE is_company = false AND company IS NOT NULL AND btrim(company) <> '';

-- 5. Backfill commercial_partner_id to self (no parents exist yet)
UPDATE public.contacts
SET commercial_partner_id = id
WHERE commercial_partner_id IS NULL;

-- 6. Trigger: maintain commercial_partner_id (root of parent chain)
CREATE OR REPLACE FUNCTION public.contacts_set_commercial_partner()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  root_id uuid;
  cur_id uuid;
  hops int := 0;
BEGIN
  IF NEW.parent_contact_id IS NULL THEN
    NEW.commercial_partner_id := NEW.id;
  ELSE
    cur_id := NEW.parent_contact_id;
    -- Walk up the chain (cap at 20 hops to prevent cycles)
    WHILE cur_id IS NOT NULL AND hops < 20 LOOP
      root_id := cur_id;
      SELECT parent_contact_id INTO cur_id FROM public.contacts WHERE id = root_id;
      hops := hops + 1;
    END LOOP;
    NEW.commercial_partner_id := COALESCE(root_id, NEW.id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_contacts_set_commercial_partner ON public.contacts;
CREATE TRIGGER trg_contacts_set_commercial_partner
BEFORE INSERT OR UPDATE OF parent_contact_id ON public.contacts
FOR EACH ROW EXECUTE FUNCTION public.contacts_set_commercial_partner();

-- 7. Trigger: keep legacy `type` enum in sync with ranks
CREATE OR REPLACE FUNCTION public.contacts_sync_type_from_ranks()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.customer_rank > 0 AND NEW.supplier_rank > 0 THEN
    NEW.type := 'both'::contact_type;
  ELSIF NEW.customer_rank > 0 THEN
    NEW.type := 'customer'::contact_type;
  ELSIF NEW.supplier_rank > 0 THEN
    NEW.type := 'supplier'::contact_type;
  END IF;
  -- If both ranks are 0, leave existing type untouched (back-compat)
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_contacts_sync_type_from_ranks ON public.contacts;
CREATE TRIGGER trg_contacts_sync_type_from_ranks
BEFORE INSERT OR UPDATE OF customer_rank, supplier_rank ON public.contacts
FOR EACH ROW EXECUTE FUNCTION public.contacts_sync_type_from_ranks();

-- 8. Indexes
CREATE INDEX IF NOT EXISTS idx_contacts_parent_contact_id
  ON public.contacts(parent_contact_id) WHERE parent_contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_contacts_commercial_partner_id
  ON public.contacts(commercial_partner_id);
CREATE INDEX IF NOT EXISTS idx_contacts_org_biz_customer_rank
  ON public.contacts(organization_id, business_id, customer_rank) WHERE customer_rank > 0;
CREATE INDEX IF NOT EXISTS idx_contacts_org_biz_supplier_rank
  ON public.contacts(organization_id, business_id, supplier_rank) WHERE supplier_rank > 0;
CREATE INDEX IF NOT EXISTS idx_contacts_is_company
  ON public.contacts(organization_id, business_id, is_company) WHERE is_company = true;