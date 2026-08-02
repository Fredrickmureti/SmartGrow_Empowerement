CREATE OR REPLACE FUNCTION public.wms_location_path(_location_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH RECURSIVE chain AS (
    SELECT l.id, l.parent_location_id, l.code, 0 AS depth
      FROM public.stock_locations l
     WHERE l.id = _location_id
    UNION ALL
    SELECT p.id, p.parent_location_id, p.code, c.depth + 1
      FROM public.stock_locations p
      JOIN chain c ON c.parent_location_id = p.id
     WHERE c.depth < 12
  )
  SELECT string_agg(code, ' / ' ORDER BY depth DESC) FROM chain;
$$;

GRANT EXECUTE ON FUNCTION public.wms_location_path(uuid) TO authenticated, service_role;

DROP VIEW IF EXISTS public.v_wms_lpn_overview;
CREATE VIEW public.v_wms_lpn_overview
WITH (security_invoker = true) AS
SELECT l.id,
    l.organization_id,
    l.business_id,
    l.branch_id,
    l.warehouse_id,
    l.code,
    l.lpn_type,
    l.status,
    l.current_location_id,
    l.parent_lpn_id,
    l.sealed_at,
    l.notes,
    l.row_version,
    l.created_at,
    l.updated_at,
    loc.code AS location_code,
    loc.name AS location_name,
    public.wms_location_path(l.current_location_id) AS location_path,
    w.name AS warehouse_name,
    COALESCE(c.sku_count, 0::bigint) AS sku_count,
    COALESCE(c.total_quantity, 0::numeric) AS total_quantity,
    COALESCE(ch.child_count, 0::bigint) AS child_count
   FROM public.wms_license_plates l
     LEFT JOIN public.stock_locations loc ON loc.id = l.current_location_id
     LEFT JOIN public.warehouses w ON w.id = l.warehouse_id
     LEFT JOIN LATERAL ( SELECT count(DISTINCT sq.product_id) AS sku_count,
            sum(sq.quantity) AS total_quantity
           FROM public.stock_quants sq
          WHERE sq.lpn_id = l.id) c ON true
     LEFT JOIN LATERAL ( SELECT count(*) AS child_count
           FROM public.wms_license_plates k
          WHERE k.parent_lpn_id = l.id) ch ON true;

GRANT SELECT ON public.v_wms_lpn_overview TO authenticated;
GRANT ALL ON public.v_wms_lpn_overview TO service_role;