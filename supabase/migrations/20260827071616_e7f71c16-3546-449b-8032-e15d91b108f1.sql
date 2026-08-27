CREATE OR REPLACE FUNCTION public._consolidation_partner_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_group public.consolidation_groups;
  v_contact public.contacts;
BEGIN
  SELECT * INTO v_group FROM public.consolidation_groups g WHERE g.id = NEW.group_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Consolidation group % does not exist', NEW.group_id;
  END IF;
  IF NEW.organization_id <> v_group.organization_id THEN
    RAISE EXCEPTION 'An intercompany declaration must belong to the same organization as its consolidation group';
  END IF;

  SELECT * INTO v_contact FROM public.contacts c WHERE c.id = NEW.contact_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Contact % does not exist', NEW.contact_id;
  END IF;
  IF v_contact.business_id IS DISTINCT FROM NEW.business_id THEN
    RAISE EXCEPTION 'Contact % belongs to a different company than the declaration claims', v_contact.name
      USING ERRCODE = '22023';
  END IF;
  IF v_contact.organization_id IS DISTINCT FROM v_group.organization_id THEN
    RAISE EXCEPTION 'Contact % is outside the group organization', v_contact.name
      USING ERRCODE = '22023';
  END IF;

  IF NEW.counterparty_business_id = NEW.business_id THEN
    RAISE EXCEPTION 'A company cannot be its own intercompany counterparty' USING ERRCODE = '22023';
  END IF;

  -- Both sides must be members of the group for the whole declared period.
  IF NOT EXISTS (
    SELECT 1 FROM public.consolidation_group_members m
     WHERE m.group_id = NEW.group_id
       AND m.business_id = NEW.business_id
       AND m.effective_from <= NEW.effective_from
       AND (m.effective_to IS NULL
            OR (NEW.effective_to IS NOT NULL AND m.effective_to >= NEW.effective_to))
  ) THEN
    RAISE EXCEPTION 'Company % is not a member of this consolidation group for the whole declared period', NEW.business_id
      USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.consolidation_group_members m
     WHERE m.group_id = NEW.group_id
       AND m.business_id = NEW.counterparty_business_id
       AND m.effective_from <= NEW.effective_from
       AND (m.effective_to IS NULL
            OR (NEW.effective_to IS NOT NULL AND m.effective_to >= NEW.effective_to))
  ) THEN
    RAISE EXCEPTION 'Counterparty company % is not a member of this consolidation group for the whole declared period',
      NEW.counterparty_business_id USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.consolidation_intercompany_partners p
     WHERE p.group_id = NEW.group_id
       AND p.contact_id = NEW.contact_id
       AND p.id <> COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid)
       AND p.effective_from < COALESCE(NEW.effective_to, 'infinity'::date)
       AND NEW.effective_from < COALESCE(p.effective_to, 'infinity'::date)
  ) THEN
    RAISE EXCEPTION 'Contact % already has an intercompany declaration covering that period; close the existing one first',
      v_contact.name USING ERRCODE = '23505';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public._consolidation_partner_guard() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER consolidation_intercompany_partners_guard
  BEFORE INSERT OR UPDATE ON public.consolidation_intercompany_partners
  FOR EACH ROW EXECUTE FUNCTION public._consolidation_partner_guard();
