CREATE OR REPLACE FUNCTION public.mf_account_mappings_audit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.mf_account_mapping_audit(business_id, branch_id, mapping_key, old_account_id, new_account_id, action, changed_by, notes)
    VALUES (NEW.business_id, NEW.branch_id, NEW.mapping_key, NULL, NEW.account_id, 'created', auth.uid(), NEW.notes);
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.account_id IS DISTINCT FROM OLD.account_id THEN
      INSERT INTO public.mf_account_mapping_audit(business_id, branch_id, mapping_key, old_account_id, new_account_id, action, changed_by, notes)
      VALUES (NEW.business_id, NEW.branch_id, NEW.mapping_key, OLD.account_id, NEW.account_id, 'changed', auth.uid(), NEW.notes);
    END IF;
    RETURN NEW;
  ELSE
    INSERT INTO public.mf_account_mapping_audit(business_id, branch_id, mapping_key, old_account_id, new_account_id, action, changed_by, notes)
    VALUES (OLD.business_id, OLD.branch_id, OLD.mapping_key, OLD.account_id, NULL, 'removed', auth.uid(), OLD.notes);
    RETURN OLD;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.mf_account_mappings_audit() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS mf_account_mappings_audit_aiud ON public.mf_account_mappings;
CREATE TRIGGER mf_account_mappings_audit_aiud
AFTER INSERT OR UPDATE OR DELETE ON public.mf_account_mappings
FOR EACH ROW EXECUTE FUNCTION public.mf_account_mappings_audit();

CREATE OR REPLACE FUNCTION public.mf_account_mapping_audit_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'MAPPING_AUDIT_IMMUTABLE: the lending mapping change log is append-only';
END;
$$;

DROP TRIGGER IF EXISTS mf_account_mapping_audit_immutable_bud ON public.mf_account_mapping_audit;
CREATE TRIGGER mf_account_mapping_audit_immutable_bud
BEFORE UPDATE OR DELETE ON public.mf_account_mapping_audit
FOR EACH ROW EXECUTE FUNCTION public.mf_account_mapping_audit_immutable();

-- Rollback:
-- DROP TRIGGER IF EXISTS mf_account_mappings_audit_aiud ON public.mf_account_mappings;
-- DROP TRIGGER IF EXISTS mf_account_mapping_audit_immutable_bud ON public.mf_account_mapping_audit;
