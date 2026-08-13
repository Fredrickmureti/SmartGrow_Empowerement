-- Phase 5.5 — server-side pagination + search for the Aged Payables vendor list.
-- The engine (finance_ap_open_items_as_of) is untouched; only the presentation
-- aggregate learns to page. Grand totals stay unfiltered so the KPI strip keeps
-- answering "what do we owe", while `filtered` describes the searched cohort so
-- the screen and the export agree on one server dataset.

CREATE OR REPLACE FUNCTION public.get_ap_aging_summary(
  p_organization_id uuid,
  p_business_id uuid,
  p_branch_id uuid DEFAULT NULL::uuid,
  p_as_of date DEFAULT CURRENT_DATE,
  p_search text DEFAULT NULL,
  p_limit integer DEFAULT NULL,
  p_offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_result jsonb;
  v_search text := NULLIF(BTRIM(COALESCE(p_search, '')), '');
  v_offset int := GREATEST(COALESCE(p_offset, 0), 0);
BEGIN
  IF NOT public.finance_can_read_org(p_organization_id) THEN
    RAISE EXCEPTION 'Not authorized for this organization' USING ERRCODE = '42501';
  END IF;

  WITH open_items AS (
    SELECT * FROM public.finance_ap_open_items_as_of(p_organization_id, p_business_id, p_branch_id, p_as_of)
  ),
  vendor_credit AS (
    SELECT contact_id AS vendor_id,
           SUM(base_credit_amount)::numeric AS credit_amt
      FROM public.finance_ap_vendor_credit_as_of(p_organization_id, p_business_id, p_branch_id, p_as_of)
     GROUP BY contact_id
  ),
  vendor_ids AS (
    SELECT contact_id AS vendor_id FROM open_items
    UNION
    SELECT vendor_id FROM vendor_credit
  ),
  bill_rows AS (
    SELECT
      o.contact_id AS vendor_id,
      COALESCE(SUM(o.base_residual_amount) FILTER (WHERE o.aging_bucket = 'not_due'), 0)::numeric AS not_due_amt,
      COALESCE(SUM(o.base_residual_amount) FILTER (WHERE o.aging_bucket = 'current'), 0)::numeric AS current_amt,
      COALESCE(SUM(o.base_residual_amount) FILTER (WHERE o.aging_bucket = 'days30'),  0)::numeric AS d30,
      COALESCE(SUM(o.base_residual_amount) FILTER (WHERE o.aging_bucket = 'days60'),  0)::numeric AS d60,
      COALESCE(SUM(o.base_residual_amount) FILTER (WHERE o.aging_bucket = 'days90'),  0)::numeric AS d90,
      COALESCE(SUM(o.base_residual_amount), 0)::numeric AS gross_amt,
      jsonb_agg(
        jsonb_build_object(
          'id',               o.document_id,
          'bill_number',      COALESCE(o.document_number, LEFT(o.document_id::text, 8)),
          'document_date',    o.document_date,
          'due_date',         o.due_date,
          'document_total',   o.document_total,
          'paid',             o.paid_amount,
          'credited',         o.credited_amount,
          'balance',          o.residual_amount,
          'base_balance',     o.base_residual_amount,
          'currency',         o.currency,
          'days_past_due',    o.days_past_due,
          'bucket',           o.aging_bucket,
          'source_kind',      o.source_kind,
          'journal_entry_id', o.journal_entry_id
        ) ORDER BY o.due_date ASC NULLS LAST
      ) AS bills
    FROM open_items o
    GROUP BY o.contact_id
  ),
  vendor_rows AS (
    SELECT
      vi.vendor_id,
      COALESCE(c.name, 'Unknown Vendor') AS vendor_name,
      COALESCE(br.not_due_amt, 0) AS not_due_amt,
      COALESCE(br.current_amt, 0) AS current_amt,
      COALESCE(br.d30, 0) AS d30,
      COALESCE(br.d60, 0) AS d60,
      COALESCE(br.d90, 0) AS d90,
      COALESCE(br.gross_amt, 0) AS gross_amt,
      COALESCE(vcr.credit_amt, 0) AS credit_amt,
      COALESCE(br.gross_amt, 0) - COALESCE(vcr.credit_amt, 0) AS total_amt,
      COALESCE(br.bills, '[]'::jsonb) AS bills
    FROM vendor_ids vi
    LEFT JOIN bill_rows br ON br.vendor_id = vi.vendor_id
    LEFT JOIN vendor_credit vcr ON vcr.vendor_id = vi.vendor_id
    LEFT JOIN public.contacts c ON c.id = vi.vendor_id
  ),
  matched AS (
    SELECT * FROM vendor_rows
     WHERE v_search IS NULL OR vendor_name ILIKE '%' || v_search || '%'
  ),
  page AS (
    SELECT * FROM matched
     ORDER BY total_amt DESC, vendor_name ASC
     OFFSET v_offset
     LIMIT CASE WHEN p_limit IS NULL OR p_limit <= 0 THEN NULL ELSE p_limit END
  )
  SELECT jsonb_build_object(
    'as_of', p_as_of,
    'currency', (SELECT base_currency FROM public.businesses WHERE id = p_business_id),
    'vendors', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'vendor_id',   vendor_id,
          'vendor_name', vendor_name,
          'not_due',     not_due_amt,
          'current',     current_amt,
          'days30',      d30,
          'days60',      d60,
          'days90',      d90,
          'gross',       gross_amt,
          'credit',      credit_amt,
          'total',       total_amt,
          'bills',       bills
        ) ORDER BY total_amt DESC, vendor_name ASC
      ) FROM page
    ), '[]'::jsonb),
    'page', jsonb_build_object(
      'limit',  p_limit,
      'offset', v_offset,
      'search', v_search,
      'returned', (SELECT COUNT(*)::int FROM page),
      'has_more', (SELECT COUNT(*) FROM matched) > v_offset + (SELECT COUNT(*) FROM page)
    ),
    'filtered', jsonb_build_object(
      'vendor_count', (SELECT COUNT(*)::int FROM matched),
      'total',        (SELECT COALESCE(SUM(total_amt), 0) FROM matched)
    ),
    'totals', jsonb_build_object(
      'not_due',      (SELECT COALESCE(SUM(not_due_amt), 0) FROM vendor_rows),
      'current',      (SELECT COALESCE(SUM(current_amt), 0) FROM vendor_rows),
      'days30',       (SELECT COALESCE(SUM(d30), 0) FROM vendor_rows),
      'days60',       (SELECT COALESCE(SUM(d60), 0) FROM vendor_rows),
      'days90',       (SELECT COALESCE(SUM(d90), 0) FROM vendor_rows),
      'gross',        (SELECT COALESCE(SUM(gross_amt), 0) FROM vendor_rows),
      'credit',       (SELECT COALESCE(SUM(credit_amt), 0) FROM vendor_rows),
      'total',        (SELECT COALESCE(SUM(total_amt), 0) FROM vendor_rows),
      'vendor_count', (SELECT COUNT(*)::int FROM vendor_rows)
    )
  ) INTO v_result;

  RETURN COALESCE(v_result, jsonb_build_object(
    'as_of', p_as_of, 'vendors', '[]'::jsonb,
    'page', jsonb_build_object('limit', p_limit, 'offset', v_offset, 'search', v_search, 'returned', 0, 'has_more', false),
    'filtered', jsonb_build_object('vendor_count', 0, 'total', 0),
    'totals', jsonb_build_object(
      'not_due',0,'current',0,'days30',0,'days60',0,'days90',0,
      'gross',0,'credit',0,'total',0,'vendor_count',0
    )
  ));
END
$function$;

REVOKE ALL ON FUNCTION public.get_ap_aging_summary(uuid, uuid, uuid, date, text, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_ap_aging_summary(uuid, uuid, uuid, date, text, integer, integer) TO authenticated, service_role;

-- Retire the 4-argument overload so there is exactly one payables aging entry point.
DROP FUNCTION IF EXISTS public.get_ap_aging_summary(uuid, uuid, uuid, date);