CREATE OR REPLACE FUNCTION public.consolidation_intercompany_scoped_entries(
  _group_id uuid, _date_to date
)
RETURNS TABLE(
  journal_entry_id uuid, business_id uuid, counterparty_business_id uuid,
  entry_date date, entry_number text, description text
)
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
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
$function$;

REVOKE ALL ON FUNCTION public.consolidation_intercompany_scoped_entries(uuid, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.consolidation_intercompany_scoped_entries(uuid, date) FROM anon;
GRANT EXECUTE ON FUNCTION public.consolidation_intercompany_scoped_entries(uuid, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.consolidation_intercompany_scoped_entries(uuid, date) TO service_role;

CREATE OR REPLACE FUNCTION public.consolidation_intercompany_entry_lines(_group_id uuid, _date_from date, _date_to date)
 RETURNS TABLE(declaring_business_id uuid, declaring_business_name text, counterparty_business_id uuid, counterparty_business_name text, account_id uuid, account_code text, account_name text, account_type account_type, group_account_id uuid, group_account_code text, group_account_name text, presentation_currency text, rate_class text, rate_used numeric, basis text, journal_entry_id uuid, entry_number text, entry_date date, entry_description text, debit_base numeric, credit_base numeric, debit_presentation numeric, credit_presentation numeric)
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

  -- One entry cannot be attributed to two sister companies at once.
  SELECT e.journal_entry_id::text INTO v_bad
    FROM (
      SELECT DISTINCT x.journal_entry_id, x.counterparty_business_id
        FROM public.consolidation_intercompany_scoped_entries(_group_id, _date_to) x
    ) e
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
    FROM public.consolidation_intercompany_scoped_entries(_group_id, _date_to) e
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
  entries AS (
    SELECT * FROM public.consolidation_intercompany_scoped_entries(_group_id, _date_to)
  ),
  scoped AS (
    SELECT e.business_id, e.counterparty_business_id, jl.account_id,
           jl.debit, jl.credit, e.journal_entry_id, e.entry_number, e.entry_date,
           e.description, t.account_type,
           CASE WHEN t.account_type IN ('income', 'expense') THEN 'period' ELSE 'cumulative' END AS basis
      FROM entries e
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