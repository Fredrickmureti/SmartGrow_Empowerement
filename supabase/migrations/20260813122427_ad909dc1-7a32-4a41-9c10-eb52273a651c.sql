CREATE OR REPLACE FUNCTION public.finance_ap_reconciliation_detail(
  _org_id uuid,
  _business_id uuid DEFAULT NULL::uuid,
  _branch_id uuid DEFAULT NULL::uuid,
  _as_of date DEFAULT CURRENT_DATE
)
RETURNS TABLE(
  contact_id uuid,
  contact_name text,
  projection_open numeric,
  projection_credit numeric,
  projection_net numeric,
  ledger_net numeric,
  variance numeric,
  reason text,
  document_count integer
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.finance_can_read_org(_org_id) THEN
    RAISE EXCEPTION 'Not authorized for this organization' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH proj AS (
    SELECT o.contact_id,
           COALESCE(SUM(o.base_residual_amount), 0)::numeric AS open_amt,
           COUNT(*)::int AS doc_count
      FROM public.finance_ap_open_items_as_of(_org_id, _business_id, _branch_id, _as_of) o
     GROUP BY o.contact_id
  ),
  cred AS (
    SELECT c.contact_id,
           COALESCE(SUM(c.base_credit_amount), 0)::numeric AS credit_amt
      FROM public.finance_ap_vendor_credit_as_of(_org_id, _business_id, _branch_id, _as_of) c
     GROUP BY c.contact_id
  ),
  ledger AS (
    SELECT s.contact_id,
           COALESCE(SUM(s.credit - s.debit), 0)::numeric AS net_amt
      FROM public.ap_subledger_entries s
     WHERE s.organization_id = _org_id
       AND (_business_id IS NULL OR s.business_id = _business_id)
       AND (_branch_id IS NULL OR s.branch_id = _branch_id)
       AND s.entry_date <= _as_of
     GROUP BY s.contact_id
  ),
  keys AS (
    SELECT proj.contact_id FROM proj
    UNION
    SELECT cred.contact_id FROM cred
    UNION
    SELECT ledger.contact_id FROM ledger
  ),
  rows_out AS (
    SELECT
      k.contact_id,
      COALESCE(ct.name, CASE WHEN k.contact_id IS NULL THEN 'Unattributed ledger entries' ELSE 'Unknown vendor' END)::text AS contact_name,
      COALESCE(p.open_amt, 0)::numeric AS projection_open,
      COALESCE(cd.credit_amt, 0)::numeric AS projection_credit,
      (COALESCE(p.open_amt, 0) - COALESCE(cd.credit_amt, 0))::numeric AS projection_net,
      COALESCE(l.net_amt, 0)::numeric AS ledger_net,
      ((COALESCE(p.open_amt, 0) - COALESCE(cd.credit_amt, 0)) - COALESCE(l.net_amt, 0))::numeric AS variance,
      CASE
        WHEN k.contact_id IS NULL THEN 'unattributed_ledger'
        WHEN p.contact_id IS NULL AND cd.contact_id IS NULL THEN 'missing_from_projection'
        WHEN l.contact_id IS NULL THEN 'missing_from_ledger'
        ELSE 'amount_mismatch'
      END::text AS reason,
      COALESCE(p.doc_count, 0)::int AS document_count
    FROM keys k
    LEFT JOIN proj   p  ON p.contact_id  IS NOT DISTINCT FROM k.contact_id
    LEFT JOIN cred   cd ON cd.contact_id IS NOT DISTINCT FROM k.contact_id
    LEFT JOIN ledger l  ON l.contact_id  IS NOT DISTINCT FROM k.contact_id
    LEFT JOIN public.contacts ct ON ct.id = k.contact_id
  )
  SELECT r.contact_id, r.contact_name,
         r.projection_open::numeric(14,2),
         r.projection_credit::numeric(14,2),
         r.projection_net::numeric(14,2),
         r.ledger_net::numeric(14,2),
         r.variance::numeric(14,2),
         r.reason,
         r.document_count
    FROM rows_out r
   WHERE ABS(r.variance) > 0.01
   ORDER BY ABS(r.variance) DESC;
END;
$function$;

REVOKE ALL ON FUNCTION public.finance_ap_reconciliation_detail(uuid, uuid, uuid, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finance_ap_reconciliation_detail(uuid, uuid, uuid, date) FROM anon;
GRANT EXECUTE ON FUNCTION public.finance_ap_reconciliation_detail(uuid, uuid, uuid, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.finance_ap_reconciliation_detail(uuid, uuid, uuid, date) TO service_role;