CREATE OR REPLACE FUNCTION public.resolve_fiscal_provider(p_org_id uuid, p_branch_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_provider_key text;
BEGIN
  -- Prefer a branch-specific active credential, then fall back to any active
  -- credential registered for the organization. Returns NULL when no fiscal
  -- provider is configured — callers treat NULL as "no fiscalization needed".
  SELECT provider_key INTO v_provider_key
    FROM public.fiscal_device_credentials
   WHERE organization_id = p_org_id
     AND is_active = true
     AND (p_branch_id IS NULL OR branch_id = p_branch_id)
   ORDER BY (branch_id = p_branch_id) DESC NULLS LAST,
            initialized_at DESC NULLS LAST
   LIMIT 1;

  IF v_provider_key IS NULL AND p_branch_id IS NOT NULL THEN
    SELECT provider_key INTO v_provider_key
      FROM public.fiscal_device_credentials
     WHERE organization_id = p_org_id
       AND is_active = true
     ORDER BY initialized_at DESC NULLS LAST
     LIMIT 1;
  END IF;

  RETURN v_provider_key;
END;
$$;

GRANT EXECUTE ON FUNCTION public.resolve_fiscal_provider(uuid, uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';