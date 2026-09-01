CREATE OR REPLACE FUNCTION public.mf_resolve_account(p_business_id uuid, p_branch_id uuid, p_key text)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_acc uuid;
BEGIN
  IF p_key IS NULL THEN
    RAISE EXCEPTION 'No accounting mapping key for this posting component';
  END IF;
  SELECT account_id INTO v_acc
    FROM public.mf_account_mappings
   WHERE business_id = p_business_id AND mapping_key = p_key
     AND (branch_id = p_branch_id OR branch_id IS NULL)
   ORDER BY (branch_id IS NOT NULL) DESC
   LIMIT 1;
  IF v_acc IS NULL THEN
    RAISE EXCEPTION 'Accounting mapping "%" is not configured. Set it under Lending → Configuration → Accounting.', p_key;
  END IF;
  RETURN v_acc;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.mf_resolve_account(uuid, uuid, text) FROM PUBLIC, anon, authenticated;