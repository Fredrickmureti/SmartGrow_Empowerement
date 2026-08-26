CREATE OR REPLACE FUNCTION public.consolidation_translate_member(
  _group_id uuid, _business_id uuid, _date_from date, _date_to date)
RETURNS TABLE(
  business_id uuid,
  business_name text,
  base_currency text,
  presentation_currency text,
  account_id uuid,
  account_code text,
  account_name text,
  account_type account_type,
  is_nominal boolean,
  rate_class text,
  rate_used numeric,
  opening_balance numeric,
  total_debit numeric,
  total_credit numeric,
  closing_balance numeric,
  translated_opening numeric,
  translated_debit numeric,
  translated_credit numeric,
  translated_closing numeric)
LANGUAGE plpgsql STABLE SET search_path TO 'public' AS $function$
DECLARE
  v_group public.consolidation_groups;
  v_biz public.businesses;
  v_r record;
  v_prior numeric;
  v_needs_translation boolean;
  v_cta_account public.accounts;
BEGIN
  IF _group_id IS NULL OR _business_id IS NULL OR _date_from IS NULL OR _date_to IS NULL THEN
    RAISE EXCEPTION 'consolidation_translate_member: group, company and date range are required';
  END IF;
  IF _date_to < _date_from THEN
    RAISE EXCEPTION 'consolidation_translate_member: date_to must not precede date_from';
  END IF;

  SELECT * INTO v_group FROM public.consolidation_groups g WHERE g.id = _group_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Consolidation group not found or not visible to you' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_biz FROM public.businesses b WHERE b.id = _business_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That company is not visible to you' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_r
    FROM public.consolidation_member_translation_rates(_group_id, _business_id, _date_from, _date_to);

  v_needs_translation := upper(COALESCE(v_biz.base_currency, '')) <> upper(v_group.presentation_currency);

  IF v_needs_translation THEN
    IF v_group.cta_account_id IS NULL THEN
      RAISE EXCEPTION 'Group % has no translation adjustment account configured; % reports in % but the group presents in %',
        v_group.name, v_biz.name, v_biz.base_currency, v_group.presentation_currency
        USING ERRCODE = '22023';
    END IF;
    SELECT * INTO v_cta_account FROM public.accounts a WHERE a.id = v_group.cta_account_id;

    IF v_r.closing_rate IS NULL OR v_r.opening_rate IS NULL OR v_r.average_rate IS NULL OR v_r.historical_rate IS NULL THEN
      RAISE EXCEPTION 'Exchange rate coverage for %->% is incomplete over % to %; translation refused rather than approximated',
        v_r.from_currency, v_r.to_currency, _date_from, _date_to
        USING ERRCODE = '22023';
    END IF;
  END IF;

  -- Pre-period retained results are carried at the prior period's average; when
  -- that cannot be computed honestly the historical rate is used instead, and
  -- the difference lands in the translation adjustment where it stays visible.
  v_prior := COALESCE(v_r.prior_average_rate, v_r.historical_rate);

  RETURN QUERY
  WITH opening AS (
    SELECT o.account_id, o.opening_balance, o.is_nominal
      FROM public.get_ledger_opening_balances(v_group.organization_id, _business_id, _date_from, NULL) o
  ),
  movement AS (
    SELECT mv.account_id, mv.total_debit, mv.total_credit
      FROM public.get_account_movements(v_group.organization_id, _date_from, _date_to, _business_id, NULL) mv
  ),
  combined AS (
    SELECT COALESCE(o.account_id, mv.account_id) AS account_id,
           COALESCE(o.opening_balance, 0)        AS opening_balance,
           COALESCE(o.is_nominal, false)         AS is_nominal,
           COALESCE(mv.total_debit, 0)           AS total_debit,
           COALESCE(mv.total_credit, 0)          AS total_credit
      FROM opening o
      FULL JOIN movement mv ON mv.account_id = o.account_id
  ),
  classified AS (
    SELECT c.account_id,
           a.code AS account_code,
           a.name AS account_name,
           a.account_type,
           c.is_nominal,
           c.opening_balance,
           c.total_debit,
           c.total_credit,
           (c.opening_balance + c.total_debit - c.total_credit) AS closing_balance,
           CASE
             WHEN a.account_type IN ('asset','liability') THEN 'closing'
             WHEN a.account_type = 'equity'               THEN 'historical'
             ELSE 'average'
           END AS rate_class
      FROM combined c
      JOIN public.accounts a ON a.id = c.account_id
     WHERE a.organization_id = v_group.organization_id
       AND (c.opening_balance <> 0 OR c.total_debit <> 0 OR c.total_credit <> 0)
  ),
  translated AS (
    SELECT cl.*,
           CASE cl.rate_class
             WHEN 'closing'    THEN v_r.closing_rate
             WHEN 'historical' THEN v_r.historical_rate
             ELSE v_r.average_rate
           END AS rate_used,
           round(cl.opening_balance * CASE cl.rate_class
                                        WHEN 'closing'    THEN v_r.opening_rate
                                        WHEN 'historical' THEN v_r.historical_rate
                                        ELSE v_prior
                                      END, 2) AS translated_opening,
           round(cl.total_debit * CASE cl.rate_class
                                    WHEN 'historical' THEN v_r.historical_rate
                                    ELSE v_r.average_rate
                                  END, 2) AS translated_debit,
           round(cl.total_credit * CASE cl.rate_class
                                     WHEN 'historical' THEN v_r.historical_rate
                                     ELSE v_r.average_rate
                                   END, 2) AS translated_credit
      FROM classified cl
  ),
  finalised AS (
    SELECT t.*,
           CASE t.rate_class
             WHEN 'closing'    THEN round(t.closing_balance * v_r.closing_rate, 2)
             WHEN 'historical' THEN round(t.closing_balance * v_r.historical_rate, 2)
             ELSE t.translated_opening + t.translated_debit - t.translated_credit
           END AS translated_closing
      FROM translated t
  ),
  -- The residual: whatever restores the translated ledger to balance IS the
  -- cumulative translation adjustment. It is never entered by hand.
  residual AS (
    SELECT COALESCE(-sum(f.translated_opening), 0) AS opening_cta,
           COALESCE(-sum(f.translated_closing), 0) AS closing_cta
      FROM finalised f
  )
  SELECT * FROM (
    SELECT 0 AS ord, v_biz.id, v_biz.name, v_biz.base_currency, v_group.presentation_currency,
           f.account_id, f.account_code, f.account_name, f.account_type, f.is_nominal,
           f.rate_class, f.rate_used,
           f.opening_balance, f.total_debit, f.total_credit, f.closing_balance,
           f.translated_opening, f.translated_debit, f.translated_credit, f.translated_closing
      FROM finalised f
    UNION ALL
    SELECT 1, v_biz.id, v_biz.name, v_biz.base_currency, v_group.presentation_currency,
           v_cta_account.id, v_cta_account.code, v_cta_account.name, v_cta_account.account_type, false,
           'residual'::text, NULL::numeric,
           0::numeric, 0::numeric, 0::numeric, 0::numeric,
           r.opening_cta,
           GREATEST(r.closing_cta - r.opening_cta, 0),
           GREATEST(r.opening_cta - r.closing_cta, 0),
           r.closing_cta
      FROM residual r
     WHERE v_needs_translation
  ) rows
  ORDER BY rows.ord, rows.account_code;
END;
$function$;

REVOKE ALL ON FUNCTION public.consolidation_translate_member(uuid, uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.consolidation_translate_member(uuid, uuid, date, date) TO authenticated, service_role;