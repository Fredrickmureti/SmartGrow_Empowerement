CREATE OR REPLACE FUNCTION public.list_negative_stock_positions(
  p_org uuid,
  p_business uuid DEFAULT NULL
)
RETURNS TABLE(
  product_id uuid,
  product_name text,
  sku text,
  warehouse_id uuid,
  warehouse_name text,
  quantity numeric,
  unit_cost numeric,
  valuation_impact numeric
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public._assert_org_member(p_org);
  RETURN QUERY
  SELECT
    ws.product_id,
    p.name,
    p.sku,
    ws.warehouse_id,
    w.name,
    ws.quantity,
    COALESCE(NULLIF(ws.average_cost, 0), p.cost_price, 0),
    ws.quantity * COALESCE(NULLIF(ws.average_cost, 0), p.cost_price, 0)
  FROM public.warehouse_stock ws
  JOIN public.products p ON p.id = ws.product_id
  LEFT JOIN public.warehouses w ON w.id = ws.warehouse_id
  WHERE ws.organization_id = p_org
    AND (p_business IS NULL OR ws.business_id = p_business)
    AND ws.quantity < 0
  ORDER BY ws.quantity ASC
  LIMIT 500;
END;
$$;

CREATE OR REPLACE FUNCTION public.list_inventory_subledger_composition(
  p_org uuid,
  p_business uuid DEFAULT NULL,
  p_limit integer DEFAULT 500
)
RETURNS TABLE(
  warehouse_id uuid,
  warehouse_name text,
  product_id uuid,
  product_name text,
  sku text,
  quantity numeric,
  unit_cost numeric,
  cost_basis text,
  value numeric
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public._assert_org_member(p_org);
  RETURN QUERY
  SELECT
    ws.warehouse_id,
    w.name,
    ws.product_id,
    p.name,
    p.sku,
    ws.quantity,
    COALESCE(NULLIF(ws.average_cost, 0), p.cost_price, 0),
    CASE
      WHEN COALESCE(ws.average_cost, 0) <> 0 THEN 'avco'
      WHEN COALESCE(p.cost_price, 0) <> 0 THEN 'product_cost'
      ELSE 'none'
    END::text,
    ws.quantity * COALESCE(NULLIF(ws.average_cost, 0), p.cost_price, 0)
  FROM public.warehouse_stock ws
  JOIN public.products p ON p.id = ws.product_id
  LEFT JOIN public.warehouses w ON w.id = ws.warehouse_id
  WHERE ws.organization_id = p_org
    AND (p_business IS NULL OR ws.business_id = p_business)
    AND ws.quantity <> 0
  ORDER BY abs(ws.quantity * COALESCE(NULLIF(ws.average_cost, 0), p.cost_price, 0)) DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 500), 1), 5000);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_accounting_integrity_findings(
  _org_id uuid,
  _business_id uuid DEFAULT NULL,
  _branch_id uuid DEFAULT NULL,
  _severity text DEFAULT NULL,
  _limit integer DEFAULT 500
)
RETURNS TABLE(
  id uuid, organization_id uuid, business_id uuid, branch_id uuid,
  severity text, finding_code text, finding_title text, finding_detail text,
  entity_type text, entity_id uuid, entity_ref text, evidence jsonb,
  detected_at timestamp with time zone
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public._assert_org_member(_org_id);
  RETURN QUERY
  WITH all_findings AS (
    SELECT * FROM public.accounting_integrity_findings
    UNION ALL
    SELECT * FROM public.accounting_integrity_findings_supplemental
    UNION ALL
    SELECT * FROM public.accounting_integrity_findings_stock_adjustments
    UNION ALL
    SELECT * FROM public.accounting_integrity_findings_stock_negative
  )
  SELECT
    f.id, f.organization_id, f.business_id, f.branch_id,
    f.severity, f.finding_code, f.finding_title, f.finding_detail,
    f.entity_type, f.entity_id, f.entity_ref, f.evidence, f.detected_at
  FROM all_findings f
  WHERE f.organization_id = _org_id
    AND (_business_id IS NULL OR f.business_id = _business_id)
    AND (_branch_id IS NULL OR f.branch_id = _branch_id OR f.branch_id IS NULL)
    AND (_severity IS NULL OR f.severity = _severity)
  ORDER BY
    CASE f.severity WHEN 'critical' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END,
    f.finding_code, f.entity_ref
  LIMIT LEAST(GREATEST(COALESCE(_limit, 500), 1), 5000);
END;
$$;