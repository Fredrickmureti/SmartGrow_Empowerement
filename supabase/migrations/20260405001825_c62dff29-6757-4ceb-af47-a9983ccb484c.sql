
-- Fixed storage breakdown function (avoid ambiguous owner_id)
CREATE OR REPLACE FUNCTION public.get_org_storage_breakdown(p_organization_id uuid)
RETURNS TABLE(
  bucket_name text,
  file_count bigint,
  total_bytes bigint,
  total_mb numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, storage
AS $$
  SELECT
    b.name AS bucket_name,
    COUNT(obj.id) AS file_count,
    COALESCE(SUM((obj.metadata->>'size')::bigint), 0) AS total_bytes,
    ROUND(COALESCE(SUM((obj.metadata->>'size')::bigint), 0) / 1048576.0, 2) AS total_mb
  FROM storage.objects obj
  JOIN storage.buckets b ON b.id = obj.bucket_id
  WHERE obj.name LIKE p_organization_id::text || '/%'
  GROUP BY b.name
  HAVING COUNT(obj.id) > 0
  ORDER BY total_bytes DESC;
$$;
