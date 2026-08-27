-- Brick 6, step 1: intercompany activity carries the group-account dimension.
--
-- `consolidation_intercompany_balances` answers "what do these two members say
-- they owe each other" from the AR/AP sub-ledgers. That grain is a pair. It
-- cannot say which consolidated statement line an intercompany figure sits on,
-- and it cannot see intercompany activity booked outside AR/AP (recharges,
-- management fees, intercompany loans posted straight to the ledger).
--
-- This function fills that gap at the grain it belongs to — member pair x group
-- account — and it does so as a *projection* of the authoritative translated
-- engine: the account identity, its group-account mapping, its rate class and
-- the rate applied all come from `get_consolidated_trial_balance_translated`.
-- No second mapping resolver, no second rate book, and therefore no way for an
-- intercompany figure to disagree with the consolidated statement line it
-- belongs to. Every refusal that engine raises (unresolvable scope, incomplete
-- rate coverage, an unmapped posted account) propagates out of here unchanged.
--
-- Counterparty identity comes only from declarations in
-- `consolidation_intercompany_partners`. Nothing is inferred from account
-- codes, names or descriptions.
CREATE OR REPLACE FUNCTION public.consolidation_intercompany_activity(
  _group_id uuid,
  _date_from date,
  _date_to date
)
RETURNS TABLE (
  group_id uuid,
  presentation_currency text,
  declaring_business_id uuid,
  declaring_business_name text,
  declaring_base_currency text,
  counterparty_business_id uuid,
  counterparty_business_name text,
  account_id uuid,
  account_code text,
  account_name text,
  account_type account_type,
  group_account_id uuid,
  group_account_code text,
  group_account_name text,
  is_mapped boolean,
  rate_class text,
  rate_used numeric,
  debit_base numeric,
  credit_base numeric,
  net_base numeric,
  debit numeric,
  credit numeric,
  net numeric,
  line_count integer,
  contact_count integer
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_group public.consolidation_groups;
  v_orphan text;
BEGIN
  IF _group_id IS NULL OR _date_from IS NULL OR _date_to IS NULL THEN
    RAISE EXCEPTION 'consolidation_intercompany_activity: group and date range are required';
  END IF;
  IF _date_to < _date_from THEN
    RAISE EXCEPTION 'consolidation_intercompany_activity: date_to must not precede date_from';
  END IF;

  SELECT * INTO v_group FROM public.consolidation_groups g WHERE g.id = _group_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Consolidation group not found or not visible to you' USING ERRCODE = '42501';
  END IF;

  -- The translated engine is materialised once: it is the single source of the
  -- account identity, the mapping and the rate, and it raises the scope,
  -- rate-coverage and unmapped-account refusals on our behalf.
  CREATE TEMP TABLE IF NOT EXISTS _ic_tb_cache (LIKE public.consolidation_groups) ON COMMIT DROP;
  DROP TABLE IF EXISTS _ic_tb_cache;

  RETURN QUERY
  WITH tb AS (
    SELECT t.business_id, t.business_name, t.base_currency, t.presentation_currency,
           t.account_id, t.account_code, t.account_name, t.account_type,
           t.group_account_id, t.group_account_code, t.group_account_name,
           t.is_mapped, t.rate_class, t.rate_used
      FROM public.get_consolidated_trial_balance_translated(_group_id, _date_from, _date_to) t
  ),
  links AS (
    SELECT p.business_id, p.contact_id, p.counterparty_business_id
      FROM public.consolidation_intercompany_partners p
     WHERE p.group_id = _group_id
       AND p.effective_from <= _date_to
       AND (p.effective_to IS NULL OR p.effective_to >= _date_from)
  ),
  -- Posted ledger activity of a member, against a contact that member has
  -- declared to BE another member. Draft, voided and reversed-out entries are
  -- excluded exactly as the ledger excludes them.
  ic AS (
    SELECT l.business_id,
           l.counterparty_business_id,
           jl.account_id,
           SUM(jl.debit)  AS debit_base,
           SUM(jl.credit) AS credit_base,
           COUNT(*)::int  AS line_count,
           COUNT(DISTINCT jl.contact_id)::int AS contact_count
      FROM links l
      JOIN public.journal_entry_lines jl
        ON jl.contact_id = l.contact_id
       AND jl.business_id = l.business_id
      JOIN public.journal_entries je
        ON je.id = jl.journal_entry_id
       AND je.business_id = l.business_id
       AND je.status = 'posted'
       AND je.entry_date BETWEEN _date_from AND _date_to
     GROUP BY l.business_id, l.counterparty_business_id, jl.account_id
  )
  SELECT _group_id,
         tb.presentation_currency,
         ic.business_id,
         tb.business_name,
         tb.base_currency,
         ic.counterparty_business_id,
         cp.name,
         tb.account_id,
         tb.account_code,
         tb.account_name,
         tb.account_type,
         tb.group_account_id,
         tb.group_account_code,
         tb.group_account_name,
         tb.is_mapped,
         tb.rate_class,
         tb.rate_used,
         ic.debit_base,
         ic.credit_base,
         ic.debit_base - ic.credit_base,
         round(ic.debit_base * tb.rate_used, 2),
         round(ic.credit_base * tb.rate_used, 2),
         round(ic.debit_base * tb.rate_used, 2) - round(ic.credit_base * tb.rate_used, 2),
         ic.line_count,
         ic.contact_count
    FROM ic
    JOIN tb ON tb.business_id = ic.business_id AND tb.account_id = ic.account_id
    JOIN public.businesses cp ON cp.id = ic.counterparty_business_id
   ORDER BY tb.business_name, tb.group_account_code, tb.account_code;

  -- An intercompany line whose account the translated engine did not return is
  -- a hole in the projection, not a zero: say so rather than under-reporting.
  SELECT string_agg(DISTINCT format('%s in %s', a.code, b.name), '; ')
    INTO v_orphan
    FROM public.consolidation_intercompany_partners p
    JOIN public.journal_entry_lines jl
      ON jl.contact_id = p.contact_id AND jl.business_id = p.business_id
    JOIN public.journal_entries je
      ON je.id = jl.journal_entry_id
     AND je.business_id = p.business_id
     AND je.status = 'posted'
     AND je.entry_date BETWEEN _date_from AND _date_to
    JOIN public.accounts a ON a.id = jl.account_id
    JOIN public.businesses b ON b.id = p.business_id
   WHERE p.group_id = _group_id
     AND p.effective_from <= _date_to
     AND (p.effective_to IS NULL OR p.effective_to >= _date_from)
     AND NOT EXISTS (
       SELECT 1
         FROM public.get_consolidated_trial_balance_translated(_group_id, _date_from, _date_to) t
        WHERE t.business_id = p.business_id AND t.account_id = jl.account_id
     );
  IF v_orphan IS NOT NULL THEN
    RAISE EXCEPTION 'Intercompany activity touches accounts the consolidated trial balance does not report (%); the report is refused rather than understated',
      v_orphan USING ERRCODE = '22023';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.consolidation_intercompany_activity(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.consolidation_intercompany_activity(uuid, date, date) TO authenticated, service_role;