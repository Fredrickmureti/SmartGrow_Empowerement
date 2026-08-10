-- Contact/Address domain hardening (ADR-0038 / ADR-0080).
-- A child `contacts` row carrying `child_address_type` IS an address, not a
-- business party. It must never carry a customer/supplier role, must always
-- have an owning party, and must not be duplicable by a retried save.

-- `type` is the denormalised role mirror; an address row has no role at all.
ALTER TABLE public.contacts ALTER COLUMN type DROP NOT NULL;

CREATE OR REPLACE FUNCTION public._contacts_address_row_is_not_a_party()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.child_address_type IS NOT NULL THEN
    NEW.customer_rank := 0;
    NEW.supplier_rank := 0;
    NEW.type := NULL;
    NEW.is_company := false;
  END IF;
  RETURN NEW;
END;
$$;

-- Named to sort AFTER trg_contacts_sync_type_from_ranks so role neutrality wins.
DROP TRIGGER IF EXISTS trg_contacts_zz_address_row_is_not_a_party ON public.contacts;
CREATE TRIGGER trg_contacts_zz_address_row_is_not_a_party
BEFORE INSERT OR UPDATE ON public.contacts
FOR EACH ROW EXECUTE FUNCTION public._contacts_address_row_is_not_a_party();

-- Backfill rows created before the guard existed.
UPDATE public.contacts
SET customer_rank = 0, supplier_rank = 0, type = NULL, is_company = false
WHERE child_address_type IS NOT NULL
  AND (customer_rank <> 0 OR supplier_rank <> 0 OR type IS NOT NULL OR is_company);

-- An address always belongs to a party.
ALTER TABLE public.contacts
  DROP CONSTRAINT IF EXISTS contacts_address_row_requires_parent;
ALTER TABLE public.contacts
  ADD CONSTRAINT contacts_address_row_requires_parent
  CHECK (child_address_type IS NULL OR parent_contact_id IS NOT NULL);

-- Idempotency: a retried "Save Address" collides instead of duplicating.
CREATE UNIQUE INDEX IF NOT EXISTS contacts_unique_address_label_per_party
  ON public.contacts (parent_contact_id, lower(name), child_address_type)
  WHERE child_address_type IS NOT NULL;