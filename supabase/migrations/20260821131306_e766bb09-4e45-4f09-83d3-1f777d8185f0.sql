CREATE OR REPLACE FUNCTION public.fx_exposure_dimensions(
  _business_id uuid,
  _as_of date DEFAULT CURRENT_DATE,
  _currency text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid;
  _base text;
  _cur text := NULLIF(upper(COALESCE(_currency, '')), '');
  _by_counterparty jsonb := '[]'::jsonb;
  _by_age jsonb := '[]'::jsonb;
  _missing text[] := ARRAY[]::text[];
  _row record;
BEGIN
  SELECT b.organization_id, upper(b.base_currency)
    INTO _org, _base
    FROM public.businesses b WHERE b.id = _business_id;
  IF _org IS NULL THEN
    RAISE EXCEPTION 'Business % not found', _business_id USING ERRCODE = 'P0002';
  END IF;
  IF NOT public.user_can_access_business(auth.uid(), _business_id) THEN
    RAISE EXCEPTION 'Not authorized for this business' USING ERRCODE = '42501';
  END IF;

  CREATE TEMP TABLE _fx_dim_lines ON COMMIT DROP AS
  SELECT upper(COALESCE(jel.original_currency, je.currency, '')) AS currency,
         jel.contact_id,
         je.entry_date,
         COALESCE(jel.original_debit, jel.debit, 0)
           - COALESCE(jel.original_credit, jel.credit, 0) AS foreign_amount,
         COALESCE(jel.debit, 0) - COALESCE(jel.credit, 0) AS booked_base_amount
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id = jel.journal_entry_id
    JOIN public.accounts a ON a.id = jel.account_id
   WHERE je.business_id = _business_id
     AND je.status = 'posted'
     AND je.entry_date <= _as_of
     AND upper(COALESCE(jel.original_currency, je.currency, '')) <> ''
     AND upper(COALESCE(jel.original_currency, je.currency, '')) <> _base
     AND (_cur IS NULL OR upper(COALESCE(jel.original_currency, je.currency, '')) = _cur)
     AND public.fx_is_monetary_account(a.account_type::text, a.detail_type::text);

  -- One rate per currency, from the one resolver. No rate => no converted figure.
  CREATE TEMP TABLE _fx_dim_rates ON COMMIT DROP AS
  SELECT c.currency, r.rate
    FROM (SELECT DISTINCT currency FROM _fx_dim_lines) c
    CROSS JOIN LATERAL public.describe_exchange_rate(_org, _business_id, c.currency, _as_of) r;

  SELECT COALESCE(array_agg(currency ORDER BY currency), ARRAY[]::text[])
    INTO _missing
    FROM _fx_dim_rates WHERE rate IS NULL OR rate <= 0;

  SELECT COALESCE(jsonb_agg(x ORDER BY x->>'currency', (x->>'exposure_abs')::numeric DESC), '[]'::jsonb)
    INTO _by_counterparty
    FROM (
      SELECT jsonb_build_object(
               'currency', l.currency,
               'contact_id', l.contact_id,
               'contact_name', COALESCE(ct.name, 'Unattributed'),
               'foreign_balance', ROUND(SUM(l.foreign_amount), 2),
               'booked_base_amount', ROUND(SUM(l.booked_base_amount), 2),
               'rate', rt.rate,
               'revalued_base_amount',
                 CASE WHEN rt.rate IS NULL OR rt.rate <= 0 THEN NULL
                      ELSE ROUND(SUM(l.foreign_amount) * rt.rate, 2) END,
               'unrealized_difference',
                 CASE WHEN rt.rate IS NULL OR rt.rate <= 0 THEN NULL
                      ELSE ROUND(SUM(l.foreign_amount) * rt.rate - SUM(l.booked_base_amount), 2) END,
               'exposure_abs', ABS(ROUND(SUM(l.foreign_amount), 2))
             ) AS x
        FROM _fx_dim_lines l
        LEFT JOIN public.contacts ct ON ct.id = l.contact_id
        LEFT JOIN _fx_dim_rates rt ON rt.currency = l.currency
       GROUP BY l.currency, l.contact_id, ct.name, rt.rate
      HAVING ABS(SUM(l.foreign_amount)) > 0.01
    ) s;

  SELECT COALESCE(jsonb_agg(x ORDER BY x->>'currency', (x->>'bucket_order')::int), '[]'::jsonb)
    INTO _by_age
    FROM (
      SELECT jsonb_build_object(
               'currency', l.currency,
               'bucket', b.bucket,
               'bucket_order', b.bucket_order,
               'foreign_balance', ROUND(SUM(l.foreign_amount), 2),
               'booked_base_amount', ROUND(SUM(l.booked_base_amount), 2),
               'rate', rt.rate,
               'revalued_base_amount',
                 CASE WHEN rt.rate IS NULL OR rt.rate <= 0 THEN NULL
                      ELSE ROUND(SUM(l.foreign_amount) * rt.rate, 2) END,
               'unrealized_difference',
                 CASE WHEN rt.rate IS NULL OR rt.rate <= 0 THEN NULL
                      ELSE ROUND(SUM(l.foreign_amount) * rt.rate - SUM(l.booked_base_amount), 2) END
             ) AS x
        FROM _fx_dim_lines l
        CROSS JOIN LATERAL (
          SELECT CASE
                   WHEN (_as_of - l.entry_date) <= 30 THEN '0-30'
                   WHEN (_as_of - l.entry_date) <= 60 THEN '31-60'
                   WHEN (_as_of - l.entry_date) <= 90 THEN '61-90'
                   ELSE '90+' END AS bucket,
                 CASE
                   WHEN (_as_of - l.entry_date) <= 30 THEN 1
                   WHEN (_as_of - l.entry_date) <= 60 THEN 2
                   WHEN (_as_of - l.entry_date) <= 90 THEN 3
                   ELSE 4 END AS bucket_order
        ) b
        LEFT JOIN _fx_dim_rates rt ON rt.currency = l.currency
       GROUP BY l.currency, b.bucket, b.bucket_order, rt.rate
      HAVING ABS(SUM(l.foreign_amount)) > 0.01
    ) s;

  RETURN jsonb_build_object(
    'base_currency',    _base,
    'as_of',            _as_of,
    'currency_filter',  _cur,
    'by_counterparty',  _by_counterparty,
    'by_age_bucket',    _by_age,
    'missing_rates',    to_jsonb(_missing)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.fx_exposure_dimensions(uuid, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fx_exposure_dimensions(uuid, date, text) TO authenticated;