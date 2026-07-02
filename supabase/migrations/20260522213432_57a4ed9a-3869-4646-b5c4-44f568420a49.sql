CREATE OR REPLACE FUNCTION public.resolve_adjustment_offset_account(
  p_org_id uuid,
  p_business_id uuid,
  p_reason text,
  p_sign numeric
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  RETURN public.resolve_adjustment_offset_account(
    p_org_id,
    p_business_id,
    p_reason,
    CASE
      WHEN COALESCE(p_sign, 0) > 0 THEN 1
      WHEN COALESCE(p_sign, 0) < 0 THEN -1
      ELSE 0
    END
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.resolve_adjustment_offset_account(uuid, uuid, text, numeric)
  TO authenticated, service_role;