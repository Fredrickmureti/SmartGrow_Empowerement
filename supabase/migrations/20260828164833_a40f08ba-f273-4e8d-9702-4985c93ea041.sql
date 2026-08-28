CREATE OR REPLACE FUNCTION public.consolidation_diagnose_eliminations(_group_id uuid, _date_from date, _date_to date)
RETURNS TABLE(finding_kind text, elimination_class consolidation_elimination_class, business_a_id uuid, business_a_name text, business_a_currency text, business_b_id uuid, business_b_name text, business_b_currency text, presentation_currency text, difference_signed numeric, difference_amount numeric, effective_tolerance numeric, effective_policy text, rule_exists boolean, is_cross_currency boolean, cause text, would_refuse boolean, suggested_tolerance numeric, remedies text[], message text)
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_group public.consolidation_groups;
  v_class public.consolidation_elimination_class;
  v_rule public.consolidation_elimination_rules;
  v_types public.account_type[];
  v_pair record;
  v_diff numeric;
  v_tol numeric;
  v_policy text;
  v_cur_a text;
  v_cur_b text;
  v_name_a text;
  v_name_b text;
  v_cross boolean;
  v_cause text;
  v_refuse boolean;
  v_remedies text[];
  v_message text;
  v_has_cta boolean;
  v_has_diff_account boolean;
  v_fx_note text;
BEGIN
  IF _group_id IS NULL OR _date_from IS NULL OR _date_to IS NULL THEN
    RAISE EXCEPTION 'consolidation_diagnose_eliminations: group and date range are required';
  END IF;
  IF _date_to < _date_from THEN
    RAISE EXCEPTION 'consolidation_diagnose_eliminations: date_to must not precede date_from';
  END IF;

  SELECT * INTO v_group FROM public.consolidation_groups g WHERE g.id = _group_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Consolidation group not found or not visible to you' USING ERRCODE = '42501';
  END IF;

  IF NOT (public.has_org_role(auth.uid(), v_group.organization_id, 'owner'::public.app_role)
       OR public.has_org_role(auth.uid(), v_group.organization_id, 'admin'::public.app_role)
       OR public.has_org_role(auth.uid(), v_group.organization_id, 'super_admin'::public.app_role)) THEN
    RAISE EXCEPTION 'You are not allowed to diagnose consolidation eliminations' USING ERRCODE = '42501';
  END IF;

  v_has_cta := v_group.cta_account_id IS NOT NULL;

  CREATE TEMP TABLE IF NOT EXISTS _ic_flows_diag (
    declaring_business_id uuid, counterparty_business_id uuid, group_account_id uuid,
    account_type public.account_type, net_debit numeric
  ) ON COMMIT DROP;
  TRUNCATE _ic_flows_diag;

  BEGIN
    INSERT INTO _ic_flows_diag
    SELECT f.declaring_business_id, f.counterparty_business_id, f.group_account_id,
           f.account_type,
           round(sum(f.debit_presentation - f.credit_presentation), 2)
      FROM public.consolidation_intercompany_flows(_group_id, _date_from, _date_to) f
     GROUP BY f.declaring_business_id, f.counterparty_business_id, f.group_account_id, f.account_type;
  EXCEPTION WHEN OTHERS THEN
    RETURN QUERY
    SELECT CASE WHEN SQLSTATE = '42501' THEN 'scope_not_reportable' ELSE 'flows_refused' END,
           NULL::public.consolidation_elimination_class,
           NULL::uuid, NULL::text, NULL::text,
           NULL::uuid, NULL::text, NULL::text,
           v_group.presentation_currency,
           NULL::numeric, NULL::numeric, NULL::numeric, NULL::text, NULL::boolean, NULL::boolean,
           CASE WHEN SQLSTATE = '42501' THEN 'scope_not_reportable' ELSE 'intercompany_flows_refused' END,
           true,
           NULL::numeric,
           CASE WHEN SQLSTATE = '42501'
                THEN ARRAY['review_group_membership']
                ELSE ARRAY['review_intercompany'] END,
           SQLERRM;
    RETURN;
  END;

  DELETE FROM _ic_flows_diag WHERE net_debit = 0;

  FOREACH v_class IN ARRAY ARRAY['intercompany_balance', 'intercompany_trading']::public.consolidation_elimination_class[]
  LOOP
    SELECT * INTO v_rule
      FROM public.consolidation_elimination_rules r
     WHERE r.group_id = _group_id AND r.elimination_class = v_class;

    IF v_rule.id IS NOT NULL AND NOT v_rule.is_active THEN
      CONTINUE;
    END IF;

    v_tol := COALESCE(v_rule.tolerance_amount, 0);
    v_policy := COALESCE(v_rule.difference_policy::text, 'refuse');
    v_has_diff_account := v_rule.difference_group_account_id IS NOT NULL;

    v_types := CASE WHEN v_class = 'intercompany_balance'
                    THEN ARRAY['asset', 'liability']::public.account_type[]
                    ELSE ARRAY['income', 'expense']::public.account_type[] END;

    FOR v_pair IN
      SELECT least(f.declaring_business_id::text, f.counterparty_business_id::text)::uuid AS a,
             greatest(f.declaring_business_id::text, f.counterparty_business_id::text)::uuid AS b,
             round(sum(f.net_debit), 2) AS diff
        FROM _ic_flows_diag f
       WHERE f.account_type = ANY (v_types)
       GROUP BY 1, 2
    LOOP
      v_diff := v_pair.diff;
      CONTINUE WHEN v_diff = 0;

      SELECT b.base_currency, b.name INTO v_cur_a, v_name_a FROM public.businesses b WHERE b.id = v_pair.a;
      SELECT b.base_currency, b.name INTO v_cur_b, v_name_b FROM public.businesses b WHERE b.id = v_pair.b;

      v_cross := (v_cur_a IS DISTINCT FROM v_cur_b)
              OR (v_cur_a IS DISTINCT FROM v_group.presentation_currency)
              OR (v_cur_b IS DISTINCT FROM v_group.presentation_currency);

      -- A member that has not retranslated its own foreign-currency monetary
      -- balances is the commonest cause of a pair that will not agree. It is
      -- that member's own exchange difference under IAS 21.45, so it is named
      -- and sent back to its books rather than absorbed by the group.
      v_fx_note := COALESCE(public.consolidation_fx_remedy_note(v_pair.a, _date_to), '')
                || COALESCE(public.consolidation_fx_remedy_note(v_pair.b, _date_to), '');
      v_fx_note := NULLIF(btrim(v_fx_note), '');

      IF abs(v_diff) <= v_tol THEN
        IF v_cross AND v_has_cta THEN
          v_cause := 'rounding_posted_to_cta';
          v_refuse := false;
          v_remedies := ARRAY[]::text[];
          v_message := format(
            'The two sides of the %s position between %s and %s differ by %s %s, within the tolerance of %s %s in force, so the run carries it to the group''s translation reserve automatically.',
            v_class, v_name_a, v_name_b, abs(v_diff), v_group.presentation_currency,
            v_tol, v_group.presentation_currency);
        ELSIF v_has_diff_account THEN
          v_cause := 'rounding_posted_to_difference';
          v_refuse := false;
          v_remedies := ARRAY[]::text[];
          v_message := format(
            'The two sides of the %s position between %s and %s differ by %s %s, within the tolerance of %s %s in force, so the run posts it to this class''s difference account automatically.',
            v_class, v_name_a, v_name_b, abs(v_diff), v_group.presentation_currency,
            v_tol, v_group.presentation_currency);
        ELSE
          v_cause := 'missing_rounding_destination';
          v_refuse := true;
          v_remedies := CASE WHEN v_cross
                             THEN ARRAY['configure_cta_account', 'configure_difference_account']
                             ELSE ARRAY['configure_difference_account'] END;
          v_message := format(
            'The two sides of the %s position between %s and %s differ by %s %s, inside the tolerance of %s %s, but the group has nowhere to carry it. Leaving it unrecorded would unbalance the consolidated statements, so the run refuses until a translation reserve or difference account is named.',
            v_class, v_name_a, v_name_b, abs(v_diff), v_group.presentation_currency,
            v_tol, v_group.presentation_currency);
        END IF;
      ELSIF v_fx_note IS NOT NULL THEN
        v_cause := 'unrecognised_member_fx';
        v_refuse := true;
        v_remedies := ARRAY['run_member_fx_revaluation', 'review_intercompany'];
        v_message := format(
          'The %s position between %s and %s differs by %s %s, and the cause is in a member''s own books, not in the group''s: %s',
          v_class, v_name_a, v_name_b, abs(v_diff), v_group.presentation_currency, v_fx_note);
      ELSIF v_policy = 'post_to_cta' AND NOT v_cross THEN
        v_cause := 'genuine_disagreement';
        v_refuse := true;
        v_remedies := ARRAY['raise_tolerance']
                   || CASE WHEN v_has_diff_account
                           THEN ARRAY['set_policy_post_difference']
                           ELSE ARRAY['configure_difference_account'] END;
        v_message := format(
          'Both %s and %s already report in %s, so their %s gap of %s %s is a real disagreement and cannot be carried to the translation reserve.',
          v_name_a, v_name_b, v_group.presentation_currency, v_class,
          abs(v_diff), v_group.presentation_currency);
      ELSIF v_policy = 'post_to_cta' AND NOT v_has_cta THEN
        v_cause := 'missing_cta_account';
        v_refuse := true;
        v_remedies := ARRAY['configure_cta_account', 'raise_tolerance'];
        v_message := format(
          'The %s position between %s and %s differs by %s %s on translation, but this group has no translation reserve account to carry it.',
          v_class, v_name_a, v_name_b, abs(v_diff), v_group.presentation_currency);
      ELSIF v_policy = 'post_difference' AND NOT v_has_diff_account THEN
        v_cause := 'missing_difference_account';
        v_refuse := true;
        v_remedies := ARRAY['configure_difference_account', 'raise_tolerance'];
        v_message := format(
          'The %s position between %s and %s differs by %s %s, but no difference account is configured for this group.',
          v_class, v_name_a, v_name_b, abs(v_diff), v_group.presentation_currency);
      ELSIF v_policy <> 'refuse' THEN
        v_cause := 'residual_disclosed';
        v_refuse := false;
        v_remedies := ARRAY[]::text[];
        v_message := format(
          'The %s position between %s and %s differs by %s %s; the policy in force carries that residual to a named account, where it stays visible.',
          v_class, v_name_a, v_name_b, abs(v_diff), v_group.presentation_currency);
      ELSIF v_cross THEN
        v_cause := 'translation_residual';
        v_refuse := true;
        v_remedies := CASE WHEN v_has_cta
                           THEN ARRAY['set_policy_post_to_cta']
                           ELSE ARRAY['configure_cta_account'] END
                   || ARRAY['raise_tolerance'];
        v_message := format(
          '%s keeps its books in %s and %s in %s while the group reports in %s, so the %s gap of %s %s is what retranslation leaves behind rather than a figure the two companies disagree on.',
          v_name_a, v_cur_a, v_name_b, v_cur_b, v_group.presentation_currency,
          v_class, abs(v_diff), v_group.presentation_currency);
      ELSE
        v_cause := 'genuine_disagreement';
        v_refuse := true;
        v_remedies := ARRAY['raise_tolerance']
                   || CASE WHEN v_has_diff_account
                           THEN ARRAY['set_policy_post_difference']
                           ELSE ARRAY['configure_difference_account'] END;
        v_message := format(
          'Both %s and %s report in %s, so their %s gap of %s %s is a figure the two companies genuinely disagree on and no reserve may absorb it.',
          v_name_a, v_name_b, v_group.presentation_currency, v_class,
          abs(v_diff), v_group.presentation_currency);
      END IF;

      RETURN QUERY SELECT
        'pair_difference'::text,
        v_class,
        v_pair.a, v_name_a, v_cur_a,
        v_pair.b, v_name_b, v_cur_b,
        v_group.presentation_currency,
        v_diff, abs(v_diff),
        v_tol, v_policy, v_rule.id IS NOT NULL,
        v_cross, v_cause, v_refuse,
        abs(v_diff),
        v_remedies,
        v_message;
    END LOOP;
  END LOOP;
END;
$function$;