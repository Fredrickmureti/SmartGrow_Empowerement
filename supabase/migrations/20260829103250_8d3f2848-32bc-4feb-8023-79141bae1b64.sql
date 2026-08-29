-- 1. Intercompany relationships must point at a company, not a person. ------
CREATE OR REPLACE FUNCTION public._consolidation_partner_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_group public.consolidation_groups;
  v_contact public.contacts;
BEGIN
  SELECT * INTO v_group FROM public.consolidation_groups g WHERE g.id = NEW.group_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Consolidation group % does not exist', NEW.group_id;
  END IF;
  IF NEW.organization_id <> v_group.organization_id THEN
    RAISE EXCEPTION 'An intercompany declaration must belong to the same organization as its consolidation group';
  END IF;

  SELECT * INTO v_contact FROM public.contacts c WHERE c.id = NEW.contact_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Contact % does not exist', NEW.contact_id;
  END IF;
  IF v_contact.business_id IS DISTINCT FROM NEW.business_id THEN
    RAISE EXCEPTION 'Contact % belongs to a different company than the declaration claims', v_contact.name
      USING ERRCODE = '22023';
  END IF;
  IF v_contact.organization_id IS DISTINCT FROM v_group.organization_id THEN
    RAISE EXCEPTION 'Contact % is outside the group organization', v_contact.name
      USING ERRCODE = '22023';
  END IF;

  -- A sister company appears in these books as a company. A natural person
  -- cannot stand in for one: every invoice raised on that person would be
  -- eliminated as intra-group trade the sister has never booked.
  IF COALESCE(v_contact.is_company, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'Contact % is recorded as an individual, not a company, so it cannot represent a group company. Use the company contact that trades with the counterparty.',
      v_contact.name USING ERRCODE = '22023';
  END IF;

  IF NEW.counterparty_business_id = NEW.business_id THEN
    RAISE EXCEPTION 'A company cannot be its own intercompany counterparty' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.consolidation_group_members m
     WHERE m.group_id = NEW.group_id
       AND m.business_id = NEW.business_id
       AND m.effective_from <= NEW.effective_from
       AND (m.effective_to IS NULL
            OR (NEW.effective_to IS NOT NULL AND m.effective_to >= NEW.effective_to))
  ) THEN
    RAISE EXCEPTION 'Company % is not a member of this consolidation group for the whole declared period', NEW.business_id
      USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.consolidation_group_members m
     WHERE m.group_id = NEW.group_id
       AND m.business_id = NEW.counterparty_business_id
       AND m.effective_from <= NEW.effective_from
       AND (m.effective_to IS NULL
            OR (NEW.effective_to IS NOT NULL AND m.effective_to >= NEW.effective_to))
  ) THEN
    RAISE EXCEPTION 'Counterparty company % is not a member of this consolidation group for the whole declared period',
      NEW.counterparty_business_id USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.consolidation_intercompany_partners p
     WHERE p.group_id = NEW.group_id
       AND p.contact_id = NEW.contact_id
       AND p.id <> COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid)
       AND p.effective_from < COALESCE(NEW.effective_to, 'infinity'::date)
       AND NEW.effective_from < COALESCE(p.effective_to, 'infinity'::date)
  ) THEN
    RAISE EXCEPTION 'Contact % already has an intercompany declaration covering that period; close the existing one first',
      v_contact.name USING ERRCODE = '23505';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public._consolidation_partner_guard() FROM PUBLIC, anon, authenticated;

-- 2. A leg is intercompany only on a date the relationship was in force. -----
DROP FUNCTION IF EXISTS public.consolidation_leg_faces_counterparty(uuid, uuid, uuid, uuid, date, date);

CREATE OR REPLACE FUNCTION public.consolidation_leg_faces_counterparty(
  _group_id uuid, _business_id uuid, _contact_id uuid, _account_id uuid, _entry_date date
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  -- A journal entry that faces a sister company still touches the outside
  -- world. The bank the money moved through, the clearing account it waited
  -- in, the tax owed to the revenue authority and the member's own exchange
  -- difference all face someone other than the sister, and the sister holds
  -- no mirror of any of them.
  --
  -- The relationship is tested on the entry's own date: a declaration that
  -- began on 27 August says nothing about an invoice raised on 18 August.
  SELECT CASE
    WHEN a.id IS NULL THEN false
    WHEN COALESCE(a.system_role, '') IN (
           'cash', 'bank', 'clearing_undeposited_funds',
           'output_tax', 'input_tax',
           'fx_unrealized_loss', 'fx_unrealized_gain',
           'fx_realized_loss', 'fx_realized_gain')
      OR COALESCE(a.detail_type, '') IN (
           'cash_on_hand', 'bank', 'undeposited_funds',
           'sales_tax_payable', 'sales_tax_receivable',
           'exchange_gain_loss')
      THEN false
    WHEN _contact_id IS NOT NULL AND EXISTS (
           SELECT 1
             FROM public.consolidation_intercompany_partners p
            WHERE p.group_id = _group_id
              AND p.business_id = _business_id
              AND p.contact_id = _contact_id
              AND _entry_date >= p.effective_from
              AND (p.effective_to IS NULL OR _entry_date <= p.effective_to))
      THEN true
    WHEN a.account_type IN ('income', 'expense') THEN true
    ELSE false
  END
  FROM public.accounts a
  WHERE a.id = _account_id
$function$;

REVOKE ALL ON FUNCTION public.consolidation_leg_faces_counterparty(uuid, uuid, uuid, uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.consolidation_leg_faces_counterparty(uuid, uuid, uuid, uuid, date) TO authenticated, service_role;

-- 3. Entry selection tests the entry's date, not the report window. ---------
CREATE OR REPLACE FUNCTION public.consolidation_intercompany_entry_lines(
  _group_id uuid, _date_from date, _date_to date
)
RETURNS TABLE(
  declaring_business_id uuid, declaring_business_name text,
  counterparty_business_id uuid, counterparty_business_name text,
  account_id uuid, account_code text, account_name text, account_type public.account_type,
  group_account_id uuid, group_account_code text, group_account_name text,
  presentation_currency text, rate_class text, rate_used numeric, basis text,
  journal_entry_id uuid, entry_number text, entry_date date, entry_description text,
  debit_base numeric, credit_base numeric,
  debit_presentation numeric, credit_presentation numeric
)
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $function$
DECLARE
  v_group public.consolidation_groups;
  v_blocker text;
  v_bad text;
BEGIN
  IF _group_id IS NULL OR _date_from IS NULL OR _date_to IS NULL THEN
    RAISE EXCEPTION 'consolidation_intercompany_entry_lines: group and date range are required';
  END IF;
  IF _date_to < _date_from THEN
    RAISE EXCEPTION 'consolidation_intercompany_entry_lines: date_to must not precede date_from';
  END IF;

  SELECT * INTO v_group FROM public.consolidation_groups g WHERE g.id = _group_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Consolidation group not found or not visible to you' USING ERRCODE = '42501';
  END IF;

  SELECT s.blocker INTO v_blocker
    FROM public.resolve_consolidation_scope(_group_id, _date_to) s
   WHERE s.blocker IS NOT NULL
   LIMIT 1;
  IF v_blocker IS NOT NULL THEN
    RAISE EXCEPTION 'Consolidation scope is not reportable: %', v_blocker USING ERRCODE = '42501';
  END IF;

  CREATE TEMP TABLE IF NOT EXISTS _ic_entries_scoped (
    journal_entry_id uuid, business_id uuid, counterparty_business_id uuid,
    entry_date date, entry_number text, description text
  ) ON COMMIT DROP;
  TRUNCATE _ic_entries_scoped;

  INSERT INTO _ic_entries_scoped
  SELECT DISTINCT jl.journal_entry_id, p.business_id, p.counterparty_business_id,
         je.entry_date, je.entry_number, je.description
    FROM public.consolidation_intercompany_partners p
    JOIN public.journal_entry_lines jl
      ON jl.contact_id = p.contact_id AND jl.business_id = p.business_id
    JOIN public.journal_entries je
      ON je.id = jl.journal_entry_id AND je.business_id = p.business_id
     AND je.status = 'posted' AND je.entry_date <= _date_to
   WHERE p.group_id = _group_id
     AND je.entry_date >= p.effective_from
     AND (p.effective_to IS NULL OR je.entry_date <= p.effective_to);

  -- One entry cannot be attributed to two sister companies at once.
  SELECT e.journal_entry_id::text INTO v_bad
    FROM (SELECT DISTINCT journal_entry_id, counterparty_business_id FROM _ic_entries_scoped) e
   GROUP BY e.journal_entry_id
  HAVING count(*) > 1
   LIMIT 1;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Journal entry % is tagged to more than one group company; intercompany flows are refused rather than split by guesswork',
      v_bad USING ERRCODE = '22023';
  END IF;

  -- A flow the consolidated trial balance does not report cannot be eliminated
  -- from it. Only the legs the engine actually consumes are held to this.
  SELECT string_agg(DISTINCT format('%s in %s', a.code, b.name), '; ')
    INTO v_bad
    FROM _ic_entries_scoped e
    JOIN public.journal_entry_lines jl
      ON jl.journal_entry_id = e.journal_entry_id AND jl.business_id = e.business_id
    JOIN public.accounts a ON a.id = jl.account_id
    JOIN public.businesses b ON b.id = e.business_id
   WHERE public.consolidation_leg_faces_counterparty(
           _group_id, e.business_id, jl.contact_id, jl.account_id, e.entry_date)
     AND NOT EXISTS (
       SELECT 1 FROM public.get_consolidated_trial_balance_translated(_group_id, _date_from, _date_to) t
        WHERE t.business_id = e.business_id AND t.account_id = jl.account_id
     );
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Intercompany entries touch accounts the consolidated trial balance does not report (%); flows are refused rather than understated',
      v_bad USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH tb AS (
    SELECT t.business_id, t.business_name, t.account_id, t.account_code, t.account_name,
           t.account_type, t.group_account_id, t.group_account_code, t.group_account_name,
           t.presentation_currency, t.rate_class::text AS rate_class, t.rate_used
      FROM public.get_consolidated_trial_balance_translated(_group_id, _date_from, _date_to) t
  ),
  scoped AS (
    SELECT e.business_id, e.counterparty_business_id, jl.account_id,
           jl.debit, jl.credit, e.journal_entry_id, e.entry_number, e.entry_date,
           e.description, t.account_type,
           CASE WHEN t.account_type IN ('income', 'expense') THEN 'period' ELSE 'cumulative' END AS basis
      FROM _ic_entries_scoped e
      JOIN public.journal_entry_lines jl
        ON jl.journal_entry_id = e.journal_entry_id AND jl.business_id = e.business_id
      JOIN tb t ON t.business_id = e.business_id AND t.account_id = jl.account_id
     WHERE public.consolidation_leg_faces_counterparty(
             _group_id, e.business_id, jl.contact_id, jl.account_id, e.entry_date)
       AND (t.account_type NOT IN ('income', 'expense')
         OR e.entry_date BETWEEN _date_from AND _date_to)
  ),
  per_entry AS (
    SELECT s.business_id, s.counterparty_business_id, s.account_id, s.basis,
           s.journal_entry_id, s.entry_number, s.entry_date, s.description,
           SUM(s.debit) AS debit_base, SUM(s.credit) AS credit_base
      FROM scoped s
     GROUP BY s.business_id, s.counterparty_business_id, s.account_id, s.basis,
              s.journal_entry_id, s.entry_number, s.entry_date, s.description
  )
  SELECT p.business_id, t.business_name, p.counterparty_business_id, cp.name,
         t.account_id, t.account_code, t.account_name, t.account_type,
         t.group_account_id, t.group_account_code, t.group_account_name,
         t.presentation_currency, t.rate_class, t.rate_used, p.basis,
         p.journal_entry_id, p.entry_number, p.entry_date, p.description,
         p.debit_base, p.credit_base,
         round(p.debit_base * t.rate_used, 2),
         round(p.credit_base * t.rate_used, 2)
    FROM per_entry p
    JOIN tb t ON t.business_id = p.business_id AND t.account_id = p.account_id
    JOIN public.businesses cp ON cp.id = p.counterparty_business_id
   WHERE p.debit_base <> 0 OR p.credit_base <> 0
   ORDER BY t.business_name, cp.name, t.group_account_code, t.account_code, p.entry_date, p.entry_number;
END;
$function$;

-- 4. Integrity report over the declarations that already exist. -------------
CREATE OR REPLACE FUNCTION public.consolidation_partner_integrity_report(_group_id uuid)
RETURNS TABLE(
  partner_id uuid, business_id uuid, business_name text,
  counterparty_business_id uuid, counterparty_business_name text,
  contact_id uuid, contact_name text, contact_is_company boolean,
  effective_from date, effective_to date,
  issue text, message text
)
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $function$
DECLARE
  v_group public.consolidation_groups;
BEGIN
  SELECT * INTO v_group FROM public.consolidation_groups g WHERE g.id = _group_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Consolidation group not found or not visible to you' USING ERRCODE = '42501';
  END IF;
  IF NOT (public.has_org_role(auth.uid(), v_group.organization_id, 'owner'::public.app_role)
       OR public.has_org_role(auth.uid(), v_group.organization_id, 'admin'::public.app_role)
       OR public.has_org_role(auth.uid(), v_group.organization_id, 'super_admin'::public.app_role)) THEN
    RAISE EXCEPTION 'You are not allowed to review intercompany declarations' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT p.id, p.business_id, b.name, p.counterparty_business_id, cb.name,
         p.contact_id, c.name, COALESCE(c.is_company, false),
         p.effective_from, p.effective_to,
         CASE WHEN COALESCE(c.is_company, false) IS NOT TRUE THEN 'contact_is_individual'
              ELSE 'not_declared_back' END,
         CASE WHEN COALESCE(c.is_company, false) IS NOT TRUE
              THEN format('%s is recorded as an individual, so every entry raised on that contact in %s is being read as trade with %s.',
                          c.name, b.name, cb.name)
              ELSE format('%s has never declared a contact standing for %s, so nothing on the other side can be matched against these entries.',
                          cb.name, b.name)
         END
    FROM public.consolidation_intercompany_partners p
    JOIN public.contacts c ON c.id = p.contact_id
    JOIN public.businesses b ON b.id = p.business_id
    JOIN public.businesses cb ON cb.id = p.counterparty_business_id
   WHERE p.group_id = _group_id
     AND (COALESCE(c.is_company, false) IS NOT TRUE
       OR NOT EXISTS (
            SELECT 1 FROM public.consolidation_intercompany_partners q
             WHERE q.group_id = p.group_id
               AND q.business_id = p.counterparty_business_id
               AND q.counterparty_business_id = p.business_id))
   ORDER BY b.name, cb.name, c.name;
END;
$function$;

REVOKE ALL ON FUNCTION public.consolidation_partner_integrity_report(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.consolidation_partner_integrity_report(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.consolidation_partner_integrity_report(uuid) IS
'Declarations in this group that cannot support an elimination: a contact that is an individual rather than a company, or a relationship the other company has never declared back.';

-- 5. A one-sided gap names the unverified relationship behind it. -----------
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
  v_sides int;
  v_only_id uuid;
  v_only_name text;
  v_silent_id uuid;
  v_silent_name text;
  v_individual text;
  v_reciprocal boolean;
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

      SELECT count(DISTINCT f.declaring_business_id)
        INTO v_sides
        FROM _ic_flows_diag f
       WHERE f.account_type = ANY (v_types)
         AND f.declaring_business_id IN (v_pair.a, v_pair.b)
         AND f.counterparty_business_id IN (v_pair.a, v_pair.b);

      SELECT f.declaring_business_id INTO v_only_id
        FROM _ic_flows_diag f
       WHERE f.account_type = ANY (v_types)
         AND f.declaring_business_id IN (v_pair.a, v_pair.b)
         AND f.counterparty_business_id IN (v_pair.a, v_pair.b)
       LIMIT 1;
      v_only_name := CASE WHEN v_only_id = v_pair.a THEN v_name_a ELSE v_name_b END;
      v_silent_id := CASE WHEN v_only_id = v_pair.a THEN v_pair.b ELSE v_pair.a END;
      v_silent_name := CASE WHEN v_only_id = v_pair.a THEN v_name_b ELSE v_name_a END;

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
      ELSIF v_sides < 2 THEN
        -- Only one company booked anything here. Before blaming the other set
        -- of books, say whether the relationship that produced these entries
        -- can support an elimination at all.
        SELECT string_agg(DISTINCT c.name, ', ') INTO v_individual
          FROM public.consolidation_intercompany_partners p
          JOIN public.contacts c ON c.id = p.contact_id
         WHERE p.group_id = _group_id
           AND p.business_id = v_only_id
           AND p.counterparty_business_id = v_silent_id
           AND COALESCE(c.is_company, false) IS NOT TRUE;

        SELECT EXISTS (
          SELECT 1 FROM public.consolidation_intercompany_partners q
           WHERE q.group_id = _group_id
             AND q.business_id = v_silent_id
             AND q.counterparty_business_id = v_only_id)
          INTO v_reciprocal;

        IF v_individual IS NOT NULL THEN
          v_cause := 'non_company_partner';
          v_refuse := true;
          v_remedies := ARRAY['review_intercompany_partners'];
          v_message := format(
            '%s of %s %s is being read as trade with %s only because the contact %s is declared as standing for that company, and that contact is an individual, not a company. Retire the declaration; this is third-party trade, not an intra-group position.',
            abs(v_diff), v_group.presentation_currency, v_class, v_silent_name, v_individual);
        ELSIF NOT v_reciprocal THEN
          v_cause := 'unverified_partner';
          v_refuse := true;
          v_remedies := ARRAY['review_intercompany_partners', 'review_intercompany'];
          v_message := format(
            'Only %s has recorded this %s position with %s, by %s %s, and %s has never declared a contact standing for %s. Until both companies declare each other the gap cannot be read as a missing entry, and no reserve may absorb it.',
            v_only_name, v_class, v_silent_name, abs(v_diff), v_group.presentation_currency,
            v_silent_name, v_only_name);
        ELSE
          v_cause := 'one_sided_flow';
          v_refuse := true;
          v_remedies := ARRAY['review_intercompany'];
          v_message := format(
            'Only %s has recorded this %s position with %s, by %s %s. %s has booked nothing against it, so the gap is a missing entry in one set of books, not an exchange difference, and no reserve may absorb it.',
            v_only_name, v_class, v_silent_name, abs(v_diff), v_group.presentation_currency,
            v_silent_name);
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