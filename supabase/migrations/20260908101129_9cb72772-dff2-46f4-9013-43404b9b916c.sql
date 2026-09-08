CREATE OR REPLACE FUNCTION public.mf_account_mapping_audit_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'MAPPING_AUDIT_IMMUTABLE: the lending mapping change log is append-only';
END;
$$;
