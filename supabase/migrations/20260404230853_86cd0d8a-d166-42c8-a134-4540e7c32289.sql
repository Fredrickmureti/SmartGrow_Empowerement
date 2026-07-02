
CREATE OR REPLACE FUNCTION public.get_org_storage_usage_mb(p_organization_id uuid)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total numeric;
BEGIN
  SELECT COALESCE(
    ROUND(SUM((o.metadata->>'size')::numeric) / (1024 * 1024), 2),
    0
  ) INTO v_total
  FROM storage.objects o
  WHERE o.name LIKE p_organization_id::text || '/%';
  
  RETURN v_total;
END;
$$;
