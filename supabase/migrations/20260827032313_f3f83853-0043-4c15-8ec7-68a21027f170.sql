-- ============================================================================
-- Brick 3 accounting corrections (IAS 21 current-rate method)
--   1. Equity movements translate at transaction-date rates, not one
--      historical rate; translated equity is never re-translated.
--   2. Missing rate coverage on an equity movement date refuses translation.
--   3. Nominal opening falls back to the prior closing rate.
--   4. The CTA residual is now independently proven from base-currency
--      figures instead of being trusted as a bare balancing figure.
-- Security posture unchanged: both functions stay SECURITY INVOKER, so the
-- caller's RLS on the ledger engine remains the access control.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.consolidation_translate_member(
  _group_id uuid, _business_id uuid, _date_from date, _date_to date
)
RETURNS TABLE(
  business_id uuid, business_name text, base_currency text, presentation_currency text,
  account_id uuid, account_code text, account_name text, account_type account_type,
  is_nominal boolean, rate_class text, rate_used numeric,
  opening_balance numeric, total_debit numeric, total_credit numeric, closing_balance numeric,
  translated_opening numeric, translated_debit numeric, translated_credit numeric, translated_closing numeric
)
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $function$
DECLARE
  v_group public.consolidation_groups;
  v_biz public.businesses;
  v_r record;
  v_prior numeric;
  v_needs_translation boolean;
  v_cta_account public.accounts;
  v_uncovered_date date;
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

    -- Equity moves at the rate of the day it moved (IAS 21.39(b)); a day with
    -- no rate on file is refused, never approximated to the average.
    SELECT t.entry_date INTO v_uncovered_date
      FROM public.get_gl_transactions(v_group.organization_id, _date_from, _date_to, NULL, NULL) t
      JOIN public.accounts a
        ON a.id = t.account_id
       AND a.business_id = _business_id
       AND a.account_type = 'equity'
     WHERE public.fx_rate_on(v_group.organization_id, v_group.parent_business_id,
                             v_biz.base_currency, v_group.presentation_currency, t.entry_date) IS NULL
     LIMIT 1;
    IF v_uncovered_date IS NOT NULL THEN
      RAISE EXCEPTION 'No %->% rate on %, the date of an equity movement in %; equity must translate at transaction-date rates so translation is refused',
        v_r.from_currency, v_r.to_currency, v_uncovered_date, v_biz.name
        USING ERRCODE = '22023';
    END IF;
  END IF;

  -- Nominal opening (within the fiscal year) at the prior-period average; when
  -- the period starts on the fiscal year boundary there is no prior average and
  -- the opening is zero anyway, so the opening (prior closing) rate is the
  -- honest fallback rather than an unrelated historical rate.
  v_prior := COALESCE(v_r.prior_average_rate, v_r.opening_rate);

  RETURN QUERY
  WITH opening AS (
    SELECT o.account_id, o.opening_balance, o.is_nominal
      FROM public.get_ledger_opening_balances(v_group.organization_id, _business_id, _date_from, NULL) o
  ),
  movement AS (
    SELECT mv.account_id, mv.total_debit, mv.total_credit
      FROM public.get_account_movements(v_group.organization_id, _date_from, _date_to, _business_id, NULL) mv
  ),
  -- Dated equity movements, each translated at its own transaction-date rate.
  equity_dated AS (
    SELECT t.account_id,
           COALESCE(SUM(t.debit), 0)  AS dr,
           COALESCE(SUM(t.credit), 0) AS cr,
           COALESCE(SUM(t.debit  * public.fx_rate_on(v_group.organization_id, v_group.parent_business_id,
                                                     v_biz.base_currency, v_group.presentation_currency, t.entry_date)), 0) AS t_dr,
           COALESCE(SUM(t.credit * public.fx_rate_on(v_group.organization_id, v_group.parent_business_id,
                                                     v_biz.base_currency, v_group.presentation_currency, t.entry_date)), 0) AS t_cr
      FROM public.get_gl_transactions(v_group.organization_id, _date_from, _date_to, NULL, NULL) t
      JOIN public.accounts a
        ON a.id = t.account_id
       AND a.business_id = _business_id
       AND a.account_type = 'equity'
     GROUP BY t.account_id
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
           CASE WHEN a.account_type = 'expense' THEN -c.opening_balance
                ELSE c.opening_balance END AS opening_balance,
           c.total_debit,
           c.total_credit,
           (a.account_type IN ('asset','expense')) AS debit_normal,
           CASE WHEN a.account_type IN ('asset','expense')
                THEN (CASE WHEN a.account_type = 'expense' THEN -c.opening_balance ELSE c.opening_balance END)
                     + c.total_debit - c.total_credit
                ELSE c.opening_balance + c.total_credit - c.total_debit END AS closing_balance,
           CASE
             WHEN a.account_type IN ('asset','liability') THEN 'closing'
             WHEN a.account_type = 'equity'               THEN 'transaction'
             ELSE 'average'
           END AS rate_class,
           COALESCE(ed.t_dr, 0) AS equity_translated_debit,
           COALESCE(ed.t_cr, 0) AS equity_translated_credit
      FROM combined c
      JOIN public.accounts a ON a.id = c.account_id
      LEFT JOIN equity_dated ed ON ed.account_id = c.account_id
     WHERE a.organization_id = v_group.organization_id
       AND (c.opening_balance <> 0 OR c.total_debit <> 0 OR c.total_credit <> 0)
  ),
  translated AS (
    SELECT cl.*,
           -- Equity has no single rate: report the effective rate actually
           -- applied to the period's movements, else the historical rate.
           CASE cl.rate_class
             WHEN 'closing'     THEN v_r.closing_rate
             WHEN 'transaction' THEN CASE
                                       WHEN cl.total_debit + cl.total_credit <> 0
                                         THEN round((cl.equity_translated_debit + cl.equity_translated_credit)
                                                    / (cl.total_debit + cl.total_credit), 6)
                                       ELSE v_r.historical_rate
                                     END
             ELSE v_r.average_rate
           END AS rate_used,
           round(cl.opening_balance * CASE cl.rate_class
                                        WHEN 'closing'     THEN v_r.opening_rate
                                        WHEN 'transaction' THEN v_r.historical_rate
                                        ELSE v_prior
                                      END, 2) AS translated_opening,
           round(CASE cl.rate_class
                   WHEN 'transaction' THEN cl.equity_translated_debit
                   ELSE cl.total_debit * v_r.average_rate
                 END, 2) AS translated_debit,
           round(CASE cl.rate_class
                   WHEN 'transaction' THEN cl.equity_translated_credit
                   ELSE cl.total_credit * v_r.average_rate
                 END, 2) AS translated_credit
      FROM classified cl
  ),
  finalised AS (
    SELECT t.*,
           CASE t.rate_class
             WHEN 'closing' THEN round(t.closing_balance * v_r.closing_rate, 2)
             -- Equity and nominal accounts accumulate their translated
             -- movements; re-translating them would destroy historical cost.
             ELSE t.translated_opening
                  + CASE WHEN t.debit_normal THEN t.translated_debit - t.translated_credit
                         ELSE t.translated_credit - t.translated_debit END
           END AS translated_closing
      FROM translated t
  ),
  residual AS (
    SELECT COALESCE(sum(CASE WHEN f.debit_normal THEN f.translated_opening ELSE -f.translated_opening END), 0) AS opening_cta,
           COALESCE(sum(CASE WHEN f.debit_normal THEN f.translated_closing ELSE -f.translated_closing END), 0) AS closing_cta
      FROM finalised f
  ),
  emitted AS (
    SELECT 0 AS ord, v_biz.id AS r_business_id, v_biz.name AS r_business_name,
           v_biz.base_currency AS r_base_currency, v_group.presentation_currency AS r_presentation_currency,
           f.account_id AS r_account_id, f.account_code AS r_account_code, f.account_name AS r_account_name,
           f.account_type AS r_account_type, f.is_nominal AS r_is_nominal,
           f.rate_class AS r_rate_class, f.rate_used AS r_rate_used,
           f.opening_balance AS r_opening_balance, f.total_debit AS r_total_debit,
           f.total_credit AS r_total_credit, f.closing_balance AS r_closing_balance,
           f.translated_opening AS r_translated_opening, f.translated_debit AS r_translated_debit,
           f.translated_credit AS r_translated_credit, f.translated_closing AS r_translated_closing
      FROM finalised f
    UNION ALL
    SELECT 1, v_biz.id, v_biz.name, v_biz.base_currency, v_group.presentation_currency,
           v_cta_account.id, v_cta_account.code, v_cta_account.name, v_cta_account.account_type, false,
           'residual'::text, NULL::numeric,
           0::numeric, 0::numeric, 0::numeric, 0::numeric,
           r.opening_cta,
           GREATEST(r.opening_cta - r.closing_cta, 0),
           GREATEST(r.closing_cta - r.opening_cta, 0),
           r.closing_cta
      FROM residual r
     WHERE v_needs_translation
  )
  SELECT e.r_business_id, e.r_business_name, e.r_base_currency, e.r_presentation_currency,
         e.r_account_id, e.r_account_code, e.r_account_name, e.r_account_type, e.r_is_nominal,
         e.r_rate_class, e.r_rate_used,
         e.r_opening_balance, e.r_total_debit, e.r_total_credit, e.r_closing_balance,
         e.r_translated_opening, e.r_translated_debit, e.r_translated_credit, e.r_translated_closing
    FROM emitted e
   ORDER BY e.ord, e.r_account_code;
END;
$function$;

-- ---------------------------------------------------------------------------
-- CTA reconciliation: the residual is only trustworthy if an independent
-- computation reproduces it. The classic proof of the reserve movement is
--   opening net assets x (closing - opening rate)
-- + period result       x (closing - average rate)
-- + each equity movement x (closing - its transaction-date rate)
-- computed from the member's own-currency ledger, never from the translated
-- table it is checking.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.consolidation_cta_reconciliation(uuid, date, date);

CREATE FUNCTION public.consolidation_cta_reconciliation(
  _group_id uuid, _date_from date, _date_to date
)
RETURNS TABLE(
  business_id uuid, business_name text, base_currency text, presentation_currency text,
  opening_rate numeric, closing_rate numeric, average_rate numeric, historical_rate numeric,
  opening_cta numeric, cta_movement numeric, closing_cta numeric,
  opening_net_assets numeric, period_result numeric, equity_movement numeric,
  expected_from_opening_net_assets numeric, expected_from_result numeric,
  expected_from_equity_movements numeric, expected_cta_movement numeric,
  movement_difference numeric, is_reconciled boolean
)
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $function$
DECLARE
  v_group public.consolidation_groups;
  v_member record;
  v_rates record;
  v_cta record;
  v_base text;
  v_open_na numeric;
  v_result numeric;
  v_eq_move numeric;
  v_eq_effect numeric;
  v_from_na numeric;
  v_from_result numeric;
  v_expected numeric;
  v_actual numeric;
  v_tolerance numeric;
  v_rows int;
BEGIN
  SELECT * INTO v_group FROM public.consolidation_groups g WHERE g.id = _group_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Consolidation group not found or not visible to you' USING ERRCODE = '42501';
  END IF;

  FOR v_member IN
    SELECT s.business_id, s.business_name, s.requires_translation
      FROM public.resolve_consolidation_scope(_group_id, _date_to) s
  LOOP
    CONTINUE WHEN NOT v_member.requires_translation;

    SELECT * INTO v_rates
      FROM public.consolidation_member_translation_rates(_group_id, v_member.business_id, _date_from, _date_to);

    SELECT t.base_currency, t.presentation_currency, t.translated_opening, t.translated_closing
      INTO v_cta
      FROM public.consolidation_translate_member(_group_id, v_member.business_id, _date_from, _date_to) t
     WHERE t.rate_class = 'residual'
     LIMIT 1;

    SELECT b.base_currency INTO v_base FROM public.businesses b WHERE b.id = v_member.business_id;

    -- Opening net assets in the member's own currency: assets less liabilities.
    SELECT COALESCE(SUM(CASE WHEN a.account_type = 'asset'     THEN o.opening_balance
                             WHEN a.account_type = 'liability' THEN -o.opening_balance
                             ELSE 0 END), 0)
      INTO v_open_na
      FROM public.get_ledger_opening_balances(v_group.organization_id, v_member.business_id, _date_from, NULL) o
      JOIN public.accounts a ON a.id = o.account_id;

    -- Period result in the member's own currency (income less expense).
    SELECT COALESCE(SUM(mv.total_credit - mv.total_debit), 0)
      INTO v_result
      FROM public.get_account_movements(v_group.organization_id, _date_from, _date_to, v_member.business_id, NULL) mv
      JOIN public.accounts a ON a.id = mv.account_id
     WHERE a.account_type IN ('income', 'expense');

    -- Equity movements and the reserve they generate, movement by movement at
    -- the difference between the closing rate and that day's rate.
    SELECT COALESCE(SUM(t.credit - t.debit), 0),
           COALESCE(SUM((t.credit - t.debit)
                        * (v_rates.closing_rate
                           - public.fx_rate_on(v_group.organization_id, v_group.parent_business_id,
                                               v_base, v_group.presentation_currency, t.entry_date))), 0)
      INTO v_eq_move, v_eq_effect
      FROM public.get_gl_transactions(v_group.organization_id, _date_from, _date_to, NULL, NULL) t
      JOIN public.accounts a
        ON a.id = t.account_id
       AND a.business_id = v_member.business_id
       AND a.account_type = 'equity';

    v_from_na     := round(v_open_na * (v_rates.closing_rate - v_rates.opening_rate), 2);
    v_from_result := round(v_result  * (v_rates.closing_rate - v_rates.average_rate), 2);
    v_eq_effect   := round(v_eq_effect, 2);
    v_expected    := v_from_na + v_from_result + v_eq_effect;
    v_actual      := COALESCE(v_cta.translated_closing, 0) - COALESCE(v_cta.translated_opening, 0);

    -- Every translated line is rounded to 2dp, so allow one cent per line.
    SELECT count(*) INTO v_rows
      FROM public.consolidation_translate_member(_group_id, v_member.business_id, _date_from, _date_to);
    v_tolerance := 0.05 + (COALESCE(v_rows, 0) * 0.02);

    RETURN QUERY SELECT
      v_member.business_id, v_member.business_name, v_cta.base_currency, v_cta.presentation_currency,
      v_rates.opening_rate, v_rates.closing_rate, v_rates.average_rate, v_rates.historical_rate,
      v_cta.translated_opening, v_actual, v_cta.translated_closing,
      v_open_na, v_result, v_eq_move,
      v_from_na, v_from_result, v_eq_effect, v_expected,
      round(v_actual - v_expected, 2),
      abs(v_actual - v_expected) <= v_tolerance;
  END LOOP;
END;
$function$;

REVOKE ALL ON FUNCTION public.consolidation_cta_reconciliation(uuid, date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.consolidation_cta_reconciliation(uuid, date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.consolidation_cta_reconciliation(uuid, date, date) TO service_role;