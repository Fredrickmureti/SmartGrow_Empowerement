-- 1. Retire the orphaned, unused flat address table.
DROP TABLE IF EXISTS public.contact_addresses;

-- 2. Default-address markers on child address contacts.
ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS is_default_shipping boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_default_billing  boolean NOT NULL DEFAULT false;

-- Only child records (those with a parent) may be flagged as defaults.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'contacts_default_addr_requires_parent'
  ) THEN
    ALTER TABLE public.contacts
      ADD CONSTRAINT contacts_default_addr_requires_parent
      CHECK (
        parent_contact_id IS NOT NULL
        OR (is_default_shipping = false AND is_default_billing = false)
      );
  END IF;
END $$;

-- 3. Address-book lookup index.
CREATE INDEX IF NOT EXISTS idx_contacts_parent_address_role
  ON public.contacts (parent_contact_id, child_address_type)
  WHERE parent_contact_id IS NOT NULL;

-- 4. At most one default ship-to / bill-to per parent.
CREATE OR REPLACE FUNCTION public._contacts_enforce_single_default_address()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.parent_contact_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.is_default_shipping THEN
    UPDATE public.contacts
       SET is_default_shipping = false
     WHERE parent_contact_id = NEW.parent_contact_id
       AND id <> NEW.id
       AND is_default_shipping;
  END IF;

  IF NEW.is_default_billing THEN
    UPDATE public.contacts
       SET is_default_billing = false
     WHERE parent_contact_id = NEW.parent_contact_id
       AND id <> NEW.id
       AND is_default_billing;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_contacts_single_default_address ON public.contacts;
CREATE TRIGGER trg_contacts_single_default_address
  AFTER INSERT OR UPDATE OF is_default_shipping, is_default_billing
  ON public.contacts
  FOR EACH ROW
  WHEN (NEW.is_default_shipping OR NEW.is_default_billing)
  EXECUTE FUNCTION public._contacts_enforce_single_default_address();