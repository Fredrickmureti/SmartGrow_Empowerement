CREATE OR REPLACE FUNCTION public.finance_ap_vendor_credit_as_of(_org_id uuid, _business_id uuid DEFAULT NULL::uuid, _branch_id uuid DEFAULT NULL::uuid, _as_of date DEFAULT CURRENT_DATE)
 RETURNS TABLE(organization_id uuid, business_id uuid, branch_id uuid, contact_id uuid, currency text, credit_amount numeric, base_credit_amount numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.finance_can_read_org(_org_id) THEN
    RAISE EXCEPTION 'Not authorized for this organization' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH notes AS (
    SELECT vcn.id, vcn.organization_id, vcn.business_id, vcn.branch_id,
           vcn.vendor_id AS contact_id,
           COALESCE(NULLIF(vcn.currency,''), 'USD') AS currency,
           vcn.total::numeric AS total
      FROM public.vendor_credit_notes vcn
     WHERE vcn.organization_id = _org_id
       AND (_business_id IS NULL OR vcn.business_id = _business_id)
       AND (_branch_id IS NULL OR vcn.branch_id = _branch_id)
       AND vcn.status NOT IN ('draft','cancelled','voided','void')
       AND vcn.credit_date <= _as_of
       AND (vcn.reversed_at IS NULL OR vcn.reversed_at::date > _as_of)
  ),
  applied AS (
    SELECT vca.credit_note_id, SUM(vca.amount)::numeric AS amount
      FROM public.vendor_credit_note_applications vca
      JOIN notes n ON n.id = vca.credit_note_id
     WHERE COALESCE(vca.applied_at::date, _as_of) <= _as_of
       AND (vca.reversed_at IS NULL OR vca.reversed_at::date > _as_of)
     GROUP BY vca.credit_note_id
  ),
  residual AS (
    SELECT n.organization_id, n.business_id, n.branch_id, n.contact_id, n.currency,
           (n.total - COALESCE(a.amount,0))::numeric AS open_amount,
           public.to_base_amount(n.business_id, n.currency, n.total - COALESCE(a.amount,0), _as_of) AS base_amount
      FROM notes n
      LEFT JOIN applied a ON a.credit_note_id = n.id
  )
  SELECT r.organization_id, r.business_id, r.branch_id, r.contact_id, r.currency,
         SUM(r.open_amount)::numeric(14,2) AS credit_amount,
         -- ADR 0136: a currency with no rate on file yields NULL, never a
         -- silently-dropped component of an otherwise complete total.
         (CASE WHEN COUNT(*) FILTER (WHERE r.base_amount IS NULL) > 0
               THEN NULL
               ELSE SUM(r.base_amount) END)::numeric(14,2) AS base_credit_amount
    FROM residual r
   GROUP BY r.organization_id, r.business_id, r.branch_id, r.contact_id, r.currency
  HAVING SUM(r.open_amount) > 0.01;
END;
$function$;