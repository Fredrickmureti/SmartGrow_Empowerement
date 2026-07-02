CREATE OR REPLACE FUNCTION public.get_invoice_status_counts(
  _org_id uuid,
  _business_id uuid DEFAULT NULL,
  _branch_id uuid DEFAULT NULL
)
RETURNS TABLE(status text, count bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT i.status::text, COUNT(*)::bigint
  FROM invoices i
  WHERE i.organization_id = _org_id
    AND (_business_id IS NULL OR i.business_id = _business_id)
    AND (_branch_id IS NULL OR i.branch_id = _branch_id OR i.branch_id IS NULL)
  GROUP BY i.status;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_bill_status_counts(
  _org_id uuid,
  _business_id uuid DEFAULT NULL,
  _branch_id uuid DEFAULT NULL
)
RETURNS TABLE(status text, count bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT b.status::text, COUNT(*)::bigint
  FROM bills b
  WHERE b.organization_id = _org_id
    AND (_business_id IS NULL OR b.business_id = _business_id)
    AND (_branch_id IS NULL OR b.branch_id = _branch_id OR b.branch_id IS NULL)
  GROUP BY b.status;
END;
$$;