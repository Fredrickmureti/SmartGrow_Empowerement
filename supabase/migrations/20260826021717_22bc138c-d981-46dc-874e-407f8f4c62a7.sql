-- Phase 4 — Rate coverage and history (D8)
-- Read-only coverage reporting. No rate is created, changed or invented anywhere below.

CREATE OR REPLACE FUNCTION public.fx_rate_coverage(p_business_id uuid)
RETURNS TABLE(
  currency text,
  first_used_on date,
  last_used_on date,
  document_count bigint,
  coverage_start date,
  latest_rate_date date,
  latest_rate numeric,
  latest_source text,
  rate_dates bigint,
  uncovered_documents bigint,
  status text
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_org  uuid;
  v_base text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.user_can_access_business(auth.uid(), p_business_id) THEN
    RAISE EXCEPTION 'Not authorised for this company' USING ERRCODE = '42501';
  END IF;

  SELECT b.organization_id, upper(b.base_currency)
    INTO v_org, v_base
    FROM public.businesses b
   WHERE b.id = p_business_id;

  IF v_base IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH usage AS (
    SELECT upper(i.currency) AS ccy, i.issue_date AS d FROM public.invoices i
      WHERE i.business_id = p_business_id AND i.currency IS NOT NULL AND i.issue_date IS NOT NULL
    UNION ALL
    SELECT upper(b.currency), b.bill_date FROM public.bills b
      WHERE b.business_id = p_business_id AND b.currency IS NOT NULL AND b.bill_date IS NOT NULL
    UNION ALL
    SELECT upper(bp.currency), bp.payment_date FROM public.bill_payments bp
      WHERE bp.business_id = p_business_id AND bp.currency IS NOT NULL AND bp.payment_date IS NOT NULL
    UNION ALL
    SELECT upper(bt.original_currency), bt.transaction_date FROM public.bank_transactions bt
      WHERE bt.business_id = p_business_id AND bt.original_currency IS NOT NULL AND bt.transaction_date IS NOT NULL
    UNION ALL
    SELECT upper(e.currency), e.issue_date FROM public.estimates e
      WHERE e.business_id = p_business_id AND e.currency IS NOT NULL AND e.issue_date IS NOT NULL
    UNION ALL
    SELECT upper(so.currency), so.order_date FROM public.sales_orders so
      WHERE so.business_id = p_business_id AND so.currency IS NOT NULL AND so.order_date IS NOT NULL
    UNION ALL
    SELECT upper(po.currency), po.order_date FROM public.purchase_orders po
      WHERE po.business_id = p_business_id AND po.currency IS NOT NULL AND po.order_date IS NOT NULL
    UNION ALL
    SELECT upper(cn.currency), cn.issue_date FROM public.credit_notes cn
      WHERE cn.business_id = p_business_id AND cn.currency IS NOT NULL AND cn.issue_date IS NOT NULL
    UNION ALL
    SELECT upper(cr.currency), cr.refund_date FROM public.customer_refunds cr
      WHERE cr.business_id = p_business_id AND cr.currency IS NOT NULL AND cr.refund_date IS NOT NULL
    UNION ALL
    SELECT upper(ex.currency), ex.expense_date FROM public.expenses ex
      WHERE ex.business_id = p_business_id AND ex.currency IS NOT NULL AND ex.expense_date IS NOT NULL
  ),
  used AS (
    SELECT u.ccy,
           min(u.d)  AS first_used_on,
           max(u.d)  AS last_used_on,
           count(*)::bigint AS document_count
      FROM usage u
     WHERE u.ccy <> v_base
     GROUP BY u.ccy
  ),
  book AS (
    SELECT upper(er.from_currency) AS ccy,
           min(er.effective_date) AS coverage_start,
           max(er.effective_date) AS latest_rate_date,
           count(DISTINCT er.effective_date)::bigint AS rate_dates
      FROM public.exchange_rates er
     WHERE er.organization_id = v_org
       AND upper(er.to_currency) = v_base
       AND (er.business_id IS NULL OR er.business_id = p_business_id)
     GROUP BY upper(er.from_currency)
  )
  SELECT u.ccy,
         u.first_used_on,
         u.last_used_on,
         u.document_count,
         bk.coverage_start,
         bk.latest_rate_date,
         pick.rate,
         pick.source,
         COALESCE(bk.rate_dates, 0),
         (SELECT count(*)::bigint
            FROM usage x
           WHERE x.ccy = u.ccy
             AND (bk.coverage_start IS NULL OR x.d < bk.coverage_start)),
         CASE
           WHEN bk.coverage_start IS NULL THEN 'none'
           WHEN u.first_used_on < bk.coverage_start THEN 'partial'
           WHEN bk.latest_rate_date < CURRENT_DATE - 7 THEN 'stale'
           ELSE 'covered'
         END
    FROM used u
    LEFT JOIN book bk ON bk.ccy = u.ccy
    LEFT JOIN LATERAL public._pick_exchange_rate_row(v_org, p_business_id, u.ccy, v_base, CURRENT_DATE) pick ON true
   ORDER BY u.ccy;
END;
$function$;

REVOKE ALL ON FUNCTION public.fx_rate_coverage(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fx_rate_coverage(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.fx_rate_coverage(uuid) TO authenticated;

-- Summary for the Currency Settings coverage indicator (Phase 8 consumes this).
CREATE OR REPLACE FUNCTION public.fx_rate_coverage_summary(p_business_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_org uuid;
  v_base text;
  v_rows jsonb;
  v_provider_as_of timestamptz;
  v_last_published timestamptz;
BEGIN
  IF auth.uid() IS NULL OR NOT public.user_can_access_business(auth.uid(), p_business_id) THEN
    RAISE EXCEPTION 'Not authorised for this company' USING ERRCODE = '42501';
  END IF;

  SELECT b.organization_id, upper(b.base_currency) INTO v_org, v_base
    FROM public.businesses b WHERE b.id = p_business_id;

  SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY c.currency), '[]'::jsonb)
    INTO v_rows
    FROM public.fx_rate_coverage(p_business_id) c;

  SELECT max(per.updated_at) INTO v_provider_as_of
    FROM public.platform_exchange_rates per WHERE per.is_active;

  SELECT max(er.published_at) INTO v_last_published
    FROM public.exchange_rates er
   WHERE er.organization_id = v_org
     AND (er.business_id IS NULL OR er.business_id = p_business_id);

  RETURN jsonb_build_object(
    'business_id', p_business_id,
    'base_currency', v_base,
    'as_of', CURRENT_DATE,
    'provider_snapshot_as_of', v_provider_as_of,
    'provider_snapshot_age_days',
      CASE WHEN v_provider_as_of IS NULL THEN NULL
           ELSE (CURRENT_DATE - v_provider_as_of::date) END,
    'last_published_at', v_last_published,
    'currencies_in_use', jsonb_array_length(v_rows),
    'currencies_without_any_rate',
      (SELECT count(*) FROM jsonb_array_elements(v_rows) e WHERE e->>'status' = 'none'),
    'currencies_partially_covered',
      (SELECT count(*) FROM jsonb_array_elements(v_rows) e WHERE e->>'status' = 'partial'),
    'currencies_stale',
      (SELECT count(*) FROM jsonb_array_elements(v_rows) e WHERE e->>'status' = 'stale'),
    'documents_before_coverage',
      (SELECT COALESCE(sum((e->>'uncovered_documents')::bigint), 0) FROM jsonb_array_elements(v_rows) e),
    'coverage', v_rows
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.fx_rate_coverage_summary(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fx_rate_coverage_summary(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.fx_rate_coverage_summary(uuid) TO authenticated;

-- Honest publish count: only rows actually recorded are counted. Behaviour otherwise unchanged.
CREATE OR REPLACE FUNCTION public.publish_platform_rates(p_on_date date DEFAULT CURRENT_DATE)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_inserted integer := 0;
  v_rows integer;
  v_biz record;
  v_usd_to_base numeric;
  v_pair record;
BEGIN
  FOR v_biz IN
    SELECT b.id, b.organization_id, upper(b.base_currency) AS base_currency
      FROM public.businesses b
     WHERE b.base_currency IS NOT NULL
  LOOP
    SELECT per.rate INTO v_usd_to_base
      FROM public.platform_exchange_rates per
     WHERE per.is_active
       AND upper(per.from_currency) = 'USD'
       AND upper(per.to_currency) = v_biz.base_currency
     LIMIT 1;

    IF v_biz.base_currency = 'USD' THEN
      v_usd_to_base := 1;
    END IF;
    CONTINUE WHEN v_usd_to_base IS NULL OR v_usd_to_base <= 0;

    FOR v_pair IN
      SELECT upper(per.to_currency) AS code, per.rate
        FROM public.platform_exchange_rates per
       WHERE per.is_active
         AND upper(per.from_currency) = 'USD'
         AND per.rate > 0
         AND upper(per.to_currency) <> v_biz.base_currency
    LOOP
      -- code -> base  =  (USD -> base) / (USD -> code)
      INSERT INTO public.exchange_rates (
        organization_id, business_id, from_currency, to_currency,
        rate, effective_date, source, provider_key, published_at
      )
      VALUES (
        v_biz.organization_id, v_biz.id, v_pair.code, v_biz.base_currency,
        ROUND(v_usd_to_base / v_pair.rate, 10), p_on_date, 'provider', 'platform', now()
      )
      ON CONFLICT DO NOTHING;

      GET DIAGNOSTICS v_rows = ROW_COUNT;
      v_inserted := v_inserted + v_rows;
    END LOOP;
  END LOOP;

  RETURN v_inserted;
END;
$function$;