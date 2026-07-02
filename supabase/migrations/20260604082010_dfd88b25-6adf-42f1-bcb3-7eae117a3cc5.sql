-- Drop legacy company text columns (Tier B finalization).
-- All UI readers have been repointed to:
--   crm_leads.company_contact (FK join to contacts.name)
--   contacts.parent (FK join to parent contact's name)

-- Safety: backfill any orphan contacts.company text into a parent company
-- contact so we don't lose data when the column is dropped.
DO $$
DECLARE
  r RECORD;
  parent_id uuid;
BEGIN
  FOR r IN
    SELECT id, organization_id, business_id, company
    FROM public.contacts
    WHERE company IS NOT NULL
      AND length(btrim(company)) > 0
      AND parent_contact_id IS NULL
      AND COALESCE(is_company, false) = false
  LOOP
    SELECT id INTO parent_id
    FROM public.contacts
    WHERE organization_id = r.organization_id
      AND business_id IS NOT DISTINCT FROM r.business_id
      AND is_company = true
      AND lower(btrim(name)) = lower(btrim(r.company))
    LIMIT 1;

    IF parent_id IS NULL THEN
      INSERT INTO public.contacts (organization_id, business_id, name, is_company, type)
      VALUES (r.organization_id, r.business_id, btrim(r.company), true, 'customer')
      RETURNING id INTO parent_id;
    END IF;

    UPDATE public.contacts SET parent_contact_id = parent_id WHERE id = r.id;
  END LOOP;
END $$;

-- crm_leads
DROP TRIGGER IF EXISTS trg_crm_leads_sync_company ON public.crm_leads;
DROP FUNCTION IF EXISTS public.trg_crm_leads_sync_company();
ALTER TABLE public.crm_leads DROP COLUMN IF EXISTS company_name;

-- contacts
DROP TRIGGER IF EXISTS trg_contacts_sync_company_text ON public.contacts;
DROP FUNCTION IF EXISTS public.trg_contacts_sync_company_text();
ALTER TABLE public.contacts DROP COLUMN IF EXISTS company;