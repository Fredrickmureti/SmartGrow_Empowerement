CREATE OR REPLACE FUNCTION public.get_consolidated_trial_balance_translated(
  _group_id uuid, _date_from date, _date_to date
)
RETURNS TABLE (
  business_id uuid, business_name text, is_parent boolean, ownership_percent numeric,
  base_currency text, presentation_currency text,
  account_id uuid, account_code text, account_name text, account_type public.account_type,
  group_account_id uuid, group_account_code text, group_account_name text, is_mapped boolean,
  is_nominal boolean, rate_class text, rate_used numeric,
  opening_balance numeric, total_debit numeric, total_credit numeric, closing_balance numeric,
  translated_opening numeric, translated_debit numeric, translated_credit numeric, translated_closing numeric
)
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $fn$
DECLARE
  v_blocker text;
  v_member record;
  v_uses_chart boolean;
  v_unmapped text;
  v_cta_ga public.consolidation_group_accounts;
BEGIN
  IF _group_id IS NULL OR _date_from IS NULL OR _date_to IS NULL THEN
    RAISE EXCEPTION 'get_consolidated_trial_balance_translated: group and date range are required';
  END IF;
  IF _date_to < _date_from THEN
    RAISE EXCEPTION 'get_consolidated_trial_balance_translated: date_to must not precede date_from';
  END IF;

  SELECT s.blocker INTO v_blocker
    FROM public.resolve_consolidation_scope(_group_id, _date_to) s
   WHERE s.blocker IS NOT NULL
   LIMIT 1;
  IF v_blocker IS NOT NULL THEN
    RAISE EXCEPTION 'Consolidation blocked: %', v_blocker;
  END IF;

  v_uses_chart := public.consolidation_group_uses_group_chart(_group_id);

  -- An unmapped posted account can neither be dropped nor passed through as its
  -- own group line: either would manufacture a figure nobody chose.
  IF v_uses_chart THEN
    SELECT string_agg(format('%s %s (%s)', u.account_code, u.account_name, u.business_name), '; '
                      ORDER BY u.business_name, u.account_code)
      INTO v_unmapped
      FROM public.consolidation_unmapped_accounts(_group_id, _date_from, _date_to) u;
    IF v_unmapped IS NOT NULL THEN
      RAISE EXCEPTION 'These posted accounts have no group account mapping: %; map them before consolidating',
        v_unmapped USING ERRCODE = '22023';
    END IF;
  END IF;

  -- The translation reserve belongs to the GROUP. Where the group keeps its own
  -- chart it is presented on the group's reserve account, not on whichever
  -- member company's equity account happens to be configured as the carrier.
  SELECT ga.* INTO v_cta_ga
    FROM public.consolidation_groups g
    JOIN public.consolidation_group_accounts ga ON ga.id = g.cta_group_account_id
   WHERE g.id = _group_id;

  IF v_uses_chart AND v_cta_ga.id IS NULL AND EXISTS (
    SELECT 1 FROM public.resolve_consolidation_scope(_group_id, _date_to) s
     WHERE s.requires_translation
  ) THEN
    RAISE EXCEPTION 'This group keeps its own chart of accounts but has no group translation reserve account configured; the reserve cannot be presented on a member company''s equity account'
      USING ERRCODE = '22023';
  END IF;

  FOR v_member IN
    SELECT s.business_id, s.business_name, s.is_parent, s.ownership_percent
      FROM public.resolve_consolidation_scope(_group_id, _date_to) s
  LOOP
    RETURN QUERY
    SELECT v_member.business_id, v_member.business_name, v_member.is_parent, v_member.ownership_percent,
           t.base_currency, t.presentation_currency,
           t.account_id, t.account_code, t.account_name, t.account_type,
           CASE WHEN t.rate_class = 'residual' THEN COALESCE(v_cta_ga.id, t.account_id)
                ELSE COALESCE(ga.id, t.account_id) END        AS group_account_id,
           CASE WHEN t.rate_class = 'residual' THEN COALESCE(v_cta_ga.code, t.account_code)
                ELSE COALESCE(ga.code, t.account_code) END    AS group_account_code,
           CASE WHEN t.rate_class = 'residual' THEN COALESCE(v_cta_ga.name, t.account_name)
                ELSE COALESCE(ga.name, t.account_name) END    AS group_account_name,
           CASE WHEN t.rate_class = 'residual' THEN (v_cta_ga.id IS NOT NULL)
                ELSE (ga.id IS NOT NULL) END                  AS is_mapped,
           t.is_nominal, t.rate_class, t.rate_used,
           t.opening_balance, t.total_debit, t.total_credit, t.closing_balance,
           t.translated_opening, t.translated_debit, t.translated_credit, t.translated_closing
      FROM public.consolidation_translate_member(_group_id, v_member.business_id, _date_from, _date_to) t
      LEFT JOIN public.consolidation_account_mappings m
             ON m.group_id = _group_id
            AND m.account_id = t.account_id
            AND m.effective_from <= _date_to
            AND (m.effective_to IS NULL OR m.effective_to >= _date_to)
            AND t.rate_class <> 'residual'
      LEFT JOIN public.consolidation_group_accounts ga ON ga.id = m.group_account_id;
  END LOOP;
END;
$fn$;