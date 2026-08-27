-- Step 7.4 — drill-down evidence for eliminations.
-- One source of intercompany truth: entry-level rows, with the aggregate
-- (consolidation_intercompany_flows) derived from them rather than computed
-- a second time. All guards live in the entry-level function so the aggregate
-- inherits the identical refusals.

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

  -- One entry cannot be attributed to two sister companies at once; guessing a
  -- split would manufacture an elimination nobody can trace.
  SELECT e.journal_entry_id::text INTO v_bad
    FROM (
      SELECT DISTINCT jl.journal_entry_id, p.counterparty_business_id
        FROM public.consolidation_intercompany_partners p
        JOIN public.journal_entry_lines jl
          ON jl.contact_id = p.contact_id AND jl.business_id = p.business_id
        JOIN public.journal_entries je
          ON je.id = jl.journal_entry_id AND je.business_id = p.business_id
         AND je.status = 'posted' AND je.entry_date <= _date_to
       WHERE p.group_id = _group_id
         AND p.effective_from <= _date_to
         AND (p.effective_to IS NULL OR p.effective_to >= _date_from)
    ) e
   GROUP BY e.journal_entry_id
  HAVING count(*) > 1
   LIMIT 1;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Journal entry % is tagged to more than one group company; intercompany flows are refused rather than split by guesswork',
      v_bad USING ERRCODE = '22023';
  END IF;

  -- A flow on an account the consolidated trial balance does not report cannot
  -- be eliminated from it.
  SELECT string_agg(DISTINCT format('%s in %s', a.code, b.name), '; ')
    INTO v_bad
    FROM (
      SELECT DISTINCT jl2.journal_entry_id, p.business_id
        FROM public.consolidation_intercompany_partners p
        JOIN public.journal_entry_lines jl2
          ON jl2.contact_id = p.contact_id AND jl2.business_id = p.business_id
        JOIN public.journal_entries je
          ON je.id = jl2.journal_entry_id AND je.business_id = p.business_id
         AND je.status = 'posted' AND je.entry_date <= _date_to
       WHERE p.group_id = _group_id
         AND p.effective_from <= _date_to
         AND (p.effective_to IS NULL OR p.effective_to >= _date_from)
    ) e
    JOIN public.journal_entry_lines jl
      ON jl.journal_entry_id = e.journal_entry_id AND jl.business_id = e.business_id
    JOIN public.accounts a ON a.id = jl.account_id
    JOIN public.businesses b ON b.id = e.business_id
   WHERE NOT EXISTS (
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
  ic_entries AS (
    SELECT DISTINCT jl.journal_entry_id, p.business_id, p.counterparty_business_id,
           je.entry_date, je.entry_number, je.description
      FROM public.consolidation_intercompany_partners p
      JOIN public.journal_entry_lines jl
        ON jl.contact_id = p.contact_id AND jl.business_id = p.business_id
      JOIN public.journal_entries je
        ON je.id = jl.journal_entry_id AND je.business_id = p.business_id
       AND je.status = 'posted' AND je.entry_date <= _date_to
     WHERE p.group_id = _group_id
       AND p.effective_from <= _date_to
       AND (p.effective_to IS NULL OR p.effective_to >= _date_from)
  ),
  -- Every leg of an intercompany entry belongs to that counterparty, including
  -- the untagged revenue or cost leg that faces it.
  scoped AS (
    SELECT e.business_id, e.counterparty_business_id, jl.account_id,
           jl.debit, jl.credit, e.journal_entry_id, e.entry_number, e.entry_date,
           e.description, t.account_type,
           CASE WHEN t.account_type IN ('income', 'expense') THEN 'period' ELSE 'cumulative' END AS basis
      FROM ic_entries e
      JOIN public.journal_entry_lines jl
        ON jl.journal_entry_id = e.journal_entry_id AND jl.business_id = e.business_id
      JOIN tb t ON t.business_id = e.business_id AND t.account_id = jl.account_id
     WHERE t.account_type NOT IN ('income', 'expense')
        OR e.entry_date BETWEEN _date_from AND _date_to
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

COMMENT ON FUNCTION public.consolidation_intercompany_entry_lines(uuid, date, date) IS
'Entry-level intercompany evidence: the posted journal entries behind every declared intra-group position, translated at the group''s rates. The single source the aggregate flows and the elimination drill-down both read.';

REVOKE ALL ON FUNCTION public.consolidation_intercompany_entry_lines(uuid, date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.consolidation_intercompany_entry_lines(uuid, date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.consolidation_intercompany_entry_lines(uuid, date, date) TO service_role;

-- The aggregate is now a projection of the entry-level truth. Same signature,
-- same columns, same numbers — the presentation amounts are re-rounded from the
-- base sums exactly as before, not summed from rounded per-entry figures.
CREATE OR REPLACE FUNCTION public.consolidation_intercompany_flows(
  _group_id uuid, _date_from date, _date_to date
)
RETURNS TABLE(
  declaring_business_id uuid, declaring_business_name text,
  counterparty_business_id uuid, counterparty_business_name text,
  account_id uuid, account_code text, account_name text, account_type public.account_type,
  group_account_id uuid, group_account_code text, group_account_name text,
  presentation_currency text, rate_class text, rate_used numeric, basis text,
  debit_base numeric, credit_base numeric,
  debit_presentation numeric, credit_presentation numeric, entry_count integer
)
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  SELECT e.declaring_business_id, min(e.declaring_business_name),
         e.counterparty_business_id, min(e.counterparty_business_name),
         e.account_id, min(e.account_code), min(e.account_name), e.account_type,
         e.group_account_id, min(e.group_account_code), min(e.group_account_name),
         min(e.presentation_currency), min(e.rate_class), min(e.rate_used), e.basis,
         sum(e.debit_base), sum(e.credit_base),
         round(sum(e.debit_base) * min(e.rate_used), 2),
         round(sum(e.credit_base) * min(e.rate_used), 2),
         count(DISTINCT e.journal_entry_id)::int
    FROM public.consolidation_intercompany_entry_lines(_group_id, _date_from, _date_to) e
   GROUP BY e.declaring_business_id, e.counterparty_business_id, e.account_id,
            e.account_type, e.group_account_id, e.basis
  HAVING sum(e.debit_base) <> 0 OR sum(e.credit_base) <> 0
   ORDER BY min(e.declaring_business_name), min(e.counterparty_business_name),
            min(e.group_account_code), min(e.account_code);
$function$;

-- The evidence behind one elimination leg: the positions consumed and, beneath
-- them, the posted entries. Authorization mirrors generation and diagnosis.
CREATE OR REPLACE FUNCTION public.consolidation_elimination_evidence(
  _group_id uuid,
  _date_from date,
  _date_to date,
  _elimination_class public.consolidation_elimination_class,
  _declaring_business_id uuid,
  _counterparty_business_id uuid,
  _group_account_id uuid
)
RETURNS TABLE(
  declaring_business_id uuid, declaring_business_name text,
  counterparty_business_id uuid, counterparty_business_name text,
  account_id uuid, account_code text, account_name text, account_type public.account_type,
  group_account_id uuid, group_account_code text, group_account_name text,
  presentation_currency text, rate_class text, rate_used numeric, basis text,
  journal_entry_id uuid, entry_number text, entry_date date, entry_description text,
  debit_base numeric, credit_base numeric,
  debit_presentation numeric, credit_presentation numeric,
  viewer_can_open_ledger boolean
)
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $function$
DECLARE
  v_group public.consolidation_groups;
  v_types public.account_type[];
BEGIN
  IF _group_id IS NULL OR _date_from IS NULL OR _date_to IS NULL
     OR _elimination_class IS NULL OR _declaring_business_id IS NULL
     OR _counterparty_business_id IS NULL OR _group_account_id IS NULL THEN
    RAISE EXCEPTION 'consolidation_elimination_evidence: group, period and the leg''s identity are all required';
  END IF;

  SELECT * INTO v_group FROM public.consolidation_groups g WHERE g.id = _group_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Consolidation group not found or not visible to you' USING ERRCODE = '42501';
  END IF;

  IF NOT (public.has_org_role(auth.uid(), v_group.organization_id, 'owner'::public.app_role)
       OR public.has_org_role(auth.uid(), v_group.organization_id, 'admin'::public.app_role)
       OR public.has_org_role(auth.uid(), v_group.organization_id, 'super_admin'::public.app_role)) THEN
    RAISE EXCEPTION 'You are not allowed to read consolidation elimination evidence' USING ERRCODE = '42501';
  END IF;

  v_types := CASE WHEN _elimination_class = 'intercompany_balance'
                  THEN ARRAY['asset', 'liability']::public.account_type[]
                  ELSE ARRAY['income', 'expense']::public.account_type[] END;

  RETURN QUERY
  SELECT e.declaring_business_id, e.declaring_business_name,
         e.counterparty_business_id, e.counterparty_business_name,
         e.account_id, e.account_code, e.account_name, e.account_type,
         e.group_account_id, e.group_account_code, e.group_account_name,
         e.presentation_currency, e.rate_class, e.rate_used, e.basis,
         e.journal_entry_id, e.entry_number, e.entry_date, e.entry_description,
         e.debit_base, e.credit_base, e.debit_presentation, e.credit_presentation,
         public.user_can_access_business(auth.uid(), e.declaring_business_id)
    FROM public.consolidation_intercompany_entry_lines(_group_id, _date_from, _date_to) e
   WHERE e.declaring_business_id = _declaring_business_id
     AND e.counterparty_business_id = _counterparty_business_id
     AND e.group_account_id = _group_account_id
     AND e.account_type = ANY (v_types)
   ORDER BY e.account_code, e.entry_date, e.entry_number;
END;
$function$;

COMMENT ON FUNCTION public.consolidation_elimination_evidence(uuid, date, date, public.consolidation_elimination_class, uuid, uuid, uuid) IS
'Drill-down for one elimination leg: the source accounts and posted journal entries the engine consumed, in both currencies, with a server-decided flag for whether the caller may open that company''s ledger.';

REVOKE ALL ON FUNCTION public.consolidation_elimination_evidence(uuid, date, date, public.consolidation_elimination_class, uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.consolidation_elimination_evidence(uuid, date, date, public.consolidation_elimination_class, uuid, uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.consolidation_elimination_evidence(uuid, date, date, public.consolidation_elimination_class, uuid, uuid, uuid) TO service_role;