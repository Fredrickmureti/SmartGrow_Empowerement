-- Phase 3 — General Ledger gains the accounting dimensions a ledger needs:
-- entry status, reversal flag, journal book, branch and currency.
DROP FUNCTION IF EXISTS public.get_general_ledger(uuid, date, date, uuid, uuid[], boolean, uuid);

CREATE OR REPLACE FUNCTION public.get_general_ledger(_org_id uuid, _date_from date, _date_to date, _business_id uuid DEFAULT NULL::uuid, _account_ids uuid[] DEFAULT NULL::uuid[], _include_zero_activity boolean DEFAULT false, _branch_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(account_id uuid, account_code text, account_name text, account_type text, opening_balance numeric, line_id uuid, entry_date date, entry_number text, je_description text, line_description text, reference text, debit numeric, credit numeric, source_type text, source_id uuid, contact_name text, entry_status text, is_reversal boolean, reversal_of_number text, journal_book text, branch_name text, entry_currency text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF _org_id IS NULL THEN
    RAISE EXCEPTION 'get_general_ledger: _org_id is required';
  END IF;

  IF NOT public.finance_can_read_org(_org_id) THEN
    RAISE EXCEPTION 'Not authorized for this organization' USING ERRCODE = '42501';
  END IF;

  IF _business_id IS NOT NULL THEN
    PERFORM 1 FROM public.businesses b
      WHERE b.id = _business_id AND b.organization_id = _org_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'get_general_ledger: business % does not belong to org %', _business_id, _org_id;
    END IF;
  END IF;

  IF _branch_id IS NOT NULL THEN
    PERFORM 1 FROM public.branches br
      WHERE br.id = _branch_id
        AND br.organization_id = _org_id
        AND (_business_id IS NULL OR br.business_id = _business_id);
    IF NOT FOUND THEN
      RAISE EXCEPTION 'get_general_ledger: branch % does not belong to org % / business %', _branch_id, _org_id, _business_id;
    END IF;
  END IF;

  RETURN QUERY
  WITH scope AS (
    SELECT a.id, a.code, a.name, a.account_type::text AS account_type,
           COALESCE(a.opening_balance, 0) AS opening_balance
    FROM public.accounts a
    WHERE a.organization_id = _org_id
      AND a.is_active = true
      AND (_business_id IS NULL OR a.business_id = _business_id)
      AND (_account_ids IS NULL OR a.id = ANY(_account_ids))
  ),
  prior AS (
    SELECT jel.account_id,
           COALESCE(SUM(jel.debit), 0)  AS prior_debit,
           COALESCE(SUM(jel.credit), 0) AS prior_credit
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id = jel.journal_entry_id
    WHERE je.organization_id = _org_id
      AND je.status = ANY (public.ledger_visible_journal_statuses())
      AND je.entry_date < _date_from
      AND (_business_id IS NULL OR je.business_id = _business_id)
      AND (_branch_id   IS NULL OR je.branch_id   = _branch_id)
    GROUP BY jel.account_id
  ),
  period_lines AS (
    SELECT
      jel.account_id, jel.id AS line_id,
      je.entry_date, je.entry_number,
      je.description AS je_description,
      jel.description AS line_description,
      je.reference,
      COALESCE(jel.debit, 0) AS debit,
      COALESCE(jel.credit, 0) AS credit,
      je.source_type, je.source_id,
      c.name AS contact_name,
      je.status AS entry_status,
      COALESCE(je.is_reversal, false) AS is_reversal,
      orig.entry_number AS reversal_of_number,
      jb.name AS journal_book,
      br.name AS branch_name,
      je.currency AS entry_currency
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id = jel.journal_entry_id
    LEFT JOIN public.contacts c ON c.id = jel.contact_id
    LEFT JOIN public.journal_entries orig ON orig.id = je.reversal_of_id
    LEFT JOIN public.journal_books jb ON jb.id = je.journal_book_id
    LEFT JOIN public.branches br ON br.id = je.branch_id
    WHERE je.organization_id = _org_id
      AND je.status = ANY (public.ledger_visible_journal_statuses())
      AND je.entry_date BETWEEN _date_from AND _date_to
      AND (_business_id IS NULL OR je.business_id = _business_id)
      AND (_branch_id   IS NULL OR je.branch_id   = _branch_id)
  ),
  scoped AS (
    SELECT
      s.id, s.code, s.name, s.account_type,
      CASE WHEN _branch_id IS NULL THEN s.opening_balance ELSE 0 END
        + CASE
            WHEN s.account_type IN ('asset', 'expense')
              THEN COALESCE(p.prior_debit, 0) - COALESCE(p.prior_credit, 0)
            ELSE COALESCE(p.prior_credit, 0) - COALESCE(p.prior_debit, 0)
          END AS opening_balance_natural,
      pl.line_id, pl.entry_date, pl.entry_number,
      pl.je_description, pl.line_description, pl.reference,
      pl.debit, pl.credit, pl.source_type, pl.source_id, pl.contact_name,
      pl.entry_status, pl.is_reversal, pl.reversal_of_number,
      pl.journal_book, pl.branch_name, pl.entry_currency
    FROM scope s
    LEFT JOIN prior p ON p.account_id = s.id
    LEFT JOIN period_lines pl ON pl.account_id = s.id
  )
  SELECT
    sc.id, sc.code, sc.name, sc.account_type,
    sc.opening_balance_natural,
    sc.line_id, sc.entry_date, sc.entry_number,
    sc.je_description, sc.line_description, sc.reference,
    sc.debit, sc.credit, sc.source_type, sc.source_id, sc.contact_name,
    sc.entry_status, sc.is_reversal, sc.reversal_of_number,
    sc.journal_book, sc.branch_name, sc.entry_currency
  FROM scoped sc
  WHERE _include_zero_activity
     OR sc.line_id IS NOT NULL
     OR sc.opening_balance_natural <> 0
  ORDER BY sc.code, sc.entry_date NULLS FIRST, sc.entry_number NULLS FIRST, sc.line_id NULLS FIRST;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_general_ledger(uuid, date, date, uuid, uuid[], boolean, uuid) TO authenticated, service_role;