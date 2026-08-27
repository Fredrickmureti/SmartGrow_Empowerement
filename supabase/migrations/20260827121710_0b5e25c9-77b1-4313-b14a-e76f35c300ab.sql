CREATE OR REPLACE FUNCTION public.consolidation_intercompany_flows(
  _group_id uuid, _date_from date, _date_to date)
RETURNS TABLE (
  declaring_business_id uuid,
  declaring_business_name text,
  counterparty_business_id uuid,
  counterparty_business_name text,
  account_id uuid,
  account_code text,
  account_name text,
  account_type public.account_type,
  group_account_id uuid,
  group_account_code text,
  group_account_name text,
  presentation_currency text,
  rate_class text,
  rate_used numeric,
  basis text,
  debit_base numeric,
  credit_base numeric,
  debit_presentation numeric,
  credit_presentation numeric,
  entry_count integer
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_group public.consolidation_groups;
  v_blocker text;
  v_bad text;
BEGIN
  IF _group_id IS NULL OR _date_from IS NULL OR _date_to IS NULL THEN
    RAISE EXCEPTION 'consolidation_intercompany_flows: group and date range are required';
  END IF;
  IF _date_to < _date_from THEN
    RAISE EXCEPTION 'consolidation_intercompany_flows: date_to must not precede date_from';
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
    SELECT DISTINCT jl.journal_entry_id, p.business_id, p.counterparty_business_id, je.entry_date
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
           jl.debit, jl.credit, e.journal_entry_id, t.account_type,
           CASE WHEN t.account_type IN ('income', 'expense') THEN 'period' ELSE 'cumulative' END AS basis
      FROM ic_entries e
      JOIN public.journal_entry_lines jl
        ON jl.journal_entry_id = e.journal_entry_id AND jl.business_id = e.business_id
      JOIN tb t ON t.business_id = e.business_id AND t.account_id = jl.account_id
     WHERE t.account_type NOT IN ('income', 'expense')
        OR e.entry_date BETWEEN _date_from AND _date_to
  ),
  agg AS (
    SELECT s.business_id, s.counterparty_business_id, s.account_id, s.basis,
           SUM(s.debit) AS debit_base, SUM(s.credit) AS credit_base,
           COUNT(DISTINCT s.journal_entry_id)::int AS entry_count
      FROM scoped s
     GROUP BY s.business_id, s.counterparty_business_id, s.account_id, s.basis
  )
  SELECT a.business_id, t.business_name, a.counterparty_business_id, cp.name,
         t.account_id, t.account_code, t.account_name, t.account_type,
         t.group_account_id, t.group_account_code, t.group_account_name,
         t.presentation_currency, t.rate_class, t.rate_used, a.basis,
         a.debit_base, a.credit_base,
         round(a.debit_base * t.rate_used, 2),
         round(a.credit_base * t.rate_used, 2),
         a.entry_count
    FROM agg a
    JOIN tb t ON t.business_id = a.business_id AND t.account_id = a.account_id
    JOIN public.businesses cp ON cp.id = a.counterparty_business_id
   WHERE a.debit_base <> 0 OR a.credit_base <> 0
   ORDER BY t.business_name, cp.name, t.group_account_code, t.account_code;
END;
$$;