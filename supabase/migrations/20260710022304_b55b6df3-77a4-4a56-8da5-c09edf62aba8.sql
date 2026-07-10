CREATE OR REPLACE FUNCTION public.resolve_adjustment_offset_account(
  p_org_id uuid,
  p_business_id uuid,
  p_reason text,
  p_sign numeric,
  p_branch_id uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT public.resolve_adjustment_offset_account(
    $1,
    $2,
    $3,
    CASE WHEN COALESCE($4, 0) < 0 THEN -1 ELSE 1 END,
    $5
  );
$$;

GRANT EXECUTE ON FUNCTION public.resolve_adjustment_offset_account(uuid, uuid, text, numeric, uuid)
  TO authenticated, service_role;