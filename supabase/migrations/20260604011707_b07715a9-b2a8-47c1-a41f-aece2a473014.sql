-- ============================================================
-- Tier B Phase 1+2: Account/Company entity normalization
-- ============================================================

-- 1. New FK column on crm_leads -----------------------------------------------

ALTER TABLE public.crm_leads
  ADD COLUMN IF NOT EXISTS company_contact_id uuid
    REFERENCES public.contacts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_crm_leads_company_contact_id
  ON public.crm_leads(company_contact_id)
  WHERE company_contact_id IS NOT NULL;

COMMENT ON COLUMN public.crm_leads.company_contact_id IS
  'FK to contacts.id where is_company=true. Authoritative; company_name kept as legacy mirror until dropped in a follow-up migration.';

-- 2. ensure_company_contact: find-or-create a company contact ----------------

CREATE OR REPLACE FUNCTION public.ensure_company_contact(
  p_org_id uuid,
  p_business_id uuid,
  p_name text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_clean text := NULLIF(btrim(p_name), '');
BEGIN
  IF v_clean IS NULL OR p_org_id IS NULL OR p_business_id IS NULL THEN
    RETURN NULL;
  END IF;

  -- Case-insensitive match within (org, business) scope.
  SELECT id INTO v_id
  FROM public.contacts
  WHERE organization_id = p_org_id
    AND business_id    = p_business_id
    AND is_company     = true
    AND lower(name)    = lower(v_clean)
  ORDER BY created_at ASC
  LIMIT 1;

  IF v_id IS NOT NULL THEN
    RETURN v_id;
  END IF;

  INSERT INTO public.contacts (
    organization_id, business_id, name, type, is_company, is_active
  ) VALUES (
    p_org_id, p_business_id, v_clean, 'customer', true, true
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.ensure_company_contact(uuid, uuid, text) TO authenticated;

-- 3. Sync trigger on crm_leads ------------------------------------------------
--    - FK set  -> mirror company name into legacy text column
--    - text set, no FK -> auto-link to an existing matching company contact
--                         (no auto-create; conversion handles that)

CREATE OR REPLACE FUNCTION public.trg_crm_leads_sync_company()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_company_name text;
  v_match uuid;
BEGIN
  IF NEW.company_contact_id IS NOT NULL THEN
    SELECT name INTO v_company_name
    FROM public.contacts
    WHERE id = NEW.company_contact_id
      AND is_company = true;

    -- If the FK points at a non-company or deleted row, clear it.
    IF v_company_name IS NULL THEN
      NEW.company_contact_id := NULL;
    ELSE
      NEW.company_name := v_company_name;
      RETURN NEW;
    END IF;
  END IF;

  -- No FK: try to auto-link by name within scope.
  IF NEW.company_name IS NOT NULL
     AND btrim(NEW.company_name) <> ''
     AND NEW.organization_id IS NOT NULL
     AND NEW.business_id IS NOT NULL
  THEN
    SELECT id INTO v_match
    FROM public.contacts
    WHERE organization_id = NEW.organization_id
      AND business_id    = NEW.business_id
      AND is_company     = true
      AND lower(name)    = lower(btrim(NEW.company_name))
    ORDER BY created_at ASC
    LIMIT 1;

    IF v_match IS NOT NULL THEN
      NEW.company_contact_id := v_match;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_crm_leads_sync_company ON public.crm_leads;
CREATE TRIGGER trg_crm_leads_sync_company
  BEFORE INSERT OR UPDATE OF company_name, company_contact_id, organization_id, business_id
  ON public.crm_leads
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_crm_leads_sync_company();

-- 4. Sync trigger on contacts -------------------------------------------------
--    - parent_contact_id (company) set -> mirror parent name into `company`
--    - `company` text set, no parent -> auto-link to existing matching company

CREATE OR REPLACE FUNCTION public.trg_contacts_sync_company_text()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_parent_name text;
  v_parent_is_company boolean;
  v_match uuid;
BEGIN
  -- Skip for company-type rows themselves; this only normalises person rows.
  IF NEW.is_company = true THEN
    RETURN NEW;
  END IF;

  IF NEW.parent_contact_id IS NOT NULL THEN
    SELECT name, is_company INTO v_parent_name, v_parent_is_company
    FROM public.contacts
    WHERE id = NEW.parent_contact_id;

    IF v_parent_is_company = true THEN
      NEW.company := v_parent_name;
      -- Odoo: commercial_partner_id follows the company root.
      IF NEW.commercial_partner_id IS NULL THEN
        NEW.commercial_partner_id := NEW.parent_contact_id;
      END IF;
      RETURN NEW;
    END IF;
  END IF;

  -- No parent: try to auto-link by free-text `company` field.
  IF NEW.company IS NOT NULL
     AND btrim(NEW.company) <> ''
     AND NEW.organization_id IS NOT NULL
     AND NEW.business_id IS NOT NULL
  THEN
    SELECT id INTO v_match
    FROM public.contacts
    WHERE organization_id = NEW.organization_id
      AND business_id    = NEW.business_id
      AND is_company     = true
      AND lower(name)    = lower(btrim(NEW.company))
      AND id <> COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid)
    ORDER BY created_at ASC
    LIMIT 1;

    IF v_match IS NOT NULL THEN
      NEW.parent_contact_id := v_match;
      IF NEW.commercial_partner_id IS NULL THEN
        NEW.commercial_partner_id := v_match;
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_contacts_sync_company_text ON public.contacts;
CREATE TRIGGER trg_contacts_sync_company_text
  BEFORE INSERT OR UPDATE OF company, parent_contact_id, is_company, organization_id, business_id
  ON public.contacts
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_contacts_sync_company_text();

-- 5. Update convert_lead_to_contact to attach via parent_contact_id ----------

CREATE OR REPLACE FUNCTION public.convert_lead_to_contact(p_lead_id uuid)
RETURNS TABLE(id uuid, name text, was_existing boolean)
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_lead public.crm_leads%ROWTYPE;
  v_existing_id uuid;
  v_existing_name text;
  v_new_id uuid;
  v_new_name text;
  v_company_id uuid;
BEGIN
  SELECT * INTO v_lead
  FROM public.crm_leads
  WHERE id = p_lead_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lead % not found', p_lead_id USING ERRCODE = 'P0002';
  END IF;

  v_existing_id := COALESCE(v_lead.contact_id, v_lead.converted_to_contact_id);

  IF v_existing_id IS NOT NULL THEN
    SELECT c.name INTO v_existing_name
    FROM public.contacts c WHERE c.id = v_existing_id;

    IF v_existing_name IS NOT NULL THEN
      RETURN QUERY SELECT v_existing_id, v_existing_name, true;
      RETURN;
    END IF;
  END IF;

  -- Resolve the company contact: prefer FK on the lead, else find-or-create
  -- from the free-text company_name.
  v_company_id := v_lead.company_contact_id;
  IF v_company_id IS NULL THEN
    v_company_id := public.ensure_company_contact(
      v_lead.organization_id, v_lead.business_id, v_lead.company_name
    );
  END IF;

  INSERT INTO public.contacts (
    organization_id, business_id, name, email, phone,
    type, notes, is_active, is_company,
    parent_contact_id, commercial_partner_id
  ) VALUES (
    v_lead.organization_id,
    v_lead.business_id,
    COALESCE(NULLIF(v_lead.contact_name, ''), v_lead.name),
    NULLIF(v_lead.email, ''),
    NULLIF(v_lead.phone, ''),
    'customer',
    NULLIF(v_lead.description, ''),
    true,
    false,                  -- person, not a company
    v_company_id,           -- Odoo parent link
    v_company_id            -- commercial partner
  )
  RETURNING contacts.id, contacts.name INTO v_new_id, v_new_name;

  UPDATE public.crm_leads
     SET contact_id = v_new_id,
         converted_to_contact_id = COALESCE(converted_to_contact_id, v_new_id),
         converted_at = COALESCE(converted_at, now()),
         company_contact_id = COALESCE(company_contact_id, v_company_id)
   WHERE id = p_lead_id;

  RETURN QUERY SELECT v_new_id, v_new_name, false;
END;
$$;

-- 6. Backfill: link existing leads to existing company contacts --------------

UPDATE public.crm_leads l
SET company_contact_id = c.id
FROM public.contacts c
WHERE l.company_contact_id IS NULL
  AND l.company_name IS NOT NULL
  AND btrim(l.company_name) <> ''
  AND c.organization_id = l.organization_id
  AND c.business_id    = l.business_id
  AND c.is_company     = true
  AND lower(c.name)    = lower(btrim(l.company_name));

-- Note: no auto-create during backfill. Unmatched leads stay text-only
-- until they're either converted or manually linked.
