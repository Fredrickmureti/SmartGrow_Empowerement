-- Phase 6 — multi-currency presentation for Ledgers & Journals.
--
-- `journal_entry_lines.debit/credit` are BASE currency and remain the
-- accounting authority: every total, balance and tie-out is base. A foreign
-- currency line additionally carries the amount as written on the source
-- document (`original_debit`/`original_credit`) and the rate used. The ledger
-- reads now surface those as SUPPLEMENTS so General Ledger and the Posting
-- Journal can print "what the document said" beside "what the books say".
--
-- Trial Balance intentionally gains nothing here: a trial balance in mixed
-- units does not balance.

DROP FUNCTION IF EXISTS public.get_general_ledger(uuid, date, date, uuid, uuid[], boolean, uuid);
DROP FUNCTION IF EXISTS public.get_journal_report(uuid, date, date, uuid, uuid, text[], integer, integer);

CREATE FUNCTION public.get_general_ledger(
  _org_id uuid, _date_from date, _date_to date,
  _business_id uuid DEFAULT NULL::uuid, _account_ids uuid[] DEFAULT NULL::uuid[],
  _include_zero_activity boolean DEFAULT false, _branch_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(account_id uuid, account_code text, account_name text, account_type text,
   opening_balance numeric, line_id uuid, entry_date date, entry_number text,
   je_description text, line_description text, reference text, debit numeric, credit numeric,
   source_type text, source_id uuid, contact_name text, entry_status text, is_reversal boolean,
   reversal_of_number text, journal_book text, branch_name text, entry_currency text,
   original_debit numeric, original_credit numeric, exchange_rate numeric)
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
      je.currency AS entry_currency,
      jel.original_debit  AS original_debit,
      jel.original_credit AS original_credit,
      COALESCE(jel.exchange_rate, je.exchange_rate) AS exchange_rate
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
      pl.journal_book, pl.branch_name, pl.entry_currency,
      pl.original_debit, pl.original_credit, pl.exchange_rate
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
    sc.journal_book, sc.branch_name, sc.entry_currency,
    sc.original_debit, sc.original_credit, sc.exchange_rate
  FROM scoped sc
  WHERE _include_zero_activity
     OR sc.line_id IS NOT NULL
     OR sc.opening_balance_natural <> 0
  ORDER BY sc.code, sc.entry_date NULLS FIRST, sc.entry_number NULLS FIRST, sc.line_id NULLS FIRST;
END;
$function$;

CREATE FUNCTION public.get_journal_report(
  _org_id uuid, _date_from date, _date_to date,
  _business_id uuid DEFAULT NULL::uuid, _branch_id uuid DEFAULT NULL::uuid,
  _source_types text[] DEFAULT NULL::text[], _limit integer DEFAULT 500, _offset integer DEFAULT 0)
 RETURNS TABLE(entry_id uuid, entry_date date, entry_number text, je_description text,
   reference text, source_type text, source_id uuid, entry_status text, is_reversal boolean,
   reversal_of_number text, journal_book text, branch_name text, entry_currency text,
   line_id uuid, account_code text, account_name text, line_description text,
   debit numeric, credit numeric, total_entries bigint,
   original_debit numeric, original_credit numeric, exchange_rate numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_total bigint;
BEGIN
  IF _org_id IS NULL THEN
    RAISE EXCEPTION 'get_journal_report: _org_id is required';
  END IF;

  IF NOT public.finance_can_read_org(_org_id) THEN
    RAISE EXCEPTION 'Not authorized for this organization' USING ERRCODE = '42501';
  END IF;

  IF _business_id IS NOT NULL THEN
    PERFORM 1 FROM public.businesses b
      WHERE b.id = _business_id AND b.organization_id = _org_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'get_journal_report: business % does not belong to org %', _business_id, _org_id;
    END IF;
  END IF;

  IF _branch_id IS NOT NULL THEN
    PERFORM 1 FROM public.branches br
      WHERE br.id = _branch_id
        AND br.organization_id = _org_id
        AND (_business_id IS NULL OR br.business_id = _business_id);
    IF NOT FOUND THEN
      RAISE EXCEPTION 'get_journal_report: branch % does not belong to org % / business %', _branch_id, _org_id, _business_id;
    END IF;
  END IF;

  SELECT count(*) INTO v_total
  FROM public.journal_entries je
  WHERE je.organization_id = _org_id
    AND je.status = ANY (public.ledger_visible_journal_statuses())
    AND je.entry_date BETWEEN _date_from AND _date_to
    AND (_business_id  IS NULL OR je.business_id = _business_id)
    AND (_branch_id    IS NULL OR je.branch_id   = _branch_id)
    AND (_source_types IS NULL OR COALESCE(je.source_type, 'manual') = ANY (_source_types));

  RETURN QUERY
  WITH page AS (
    SELECT je.*
    FROM public.journal_entries je
    WHERE je.organization_id = _org_id
      AND je.status = ANY (public.ledger_visible_journal_statuses())
      AND je.entry_date BETWEEN _date_from AND _date_to
      AND (_business_id  IS NULL OR je.business_id = _business_id)
      AND (_branch_id    IS NULL OR je.branch_id   = _branch_id)
      AND (_source_types IS NULL OR COALESCE(je.source_type, 'manual') = ANY (_source_types))
    ORDER BY je.entry_date DESC, je.entry_number DESC
    LIMIT GREATEST(COALESCE(_limit, 500), 1)
    OFFSET GREATEST(COALESCE(_offset, 0), 0)
  )
  SELECT
    p.id, p.entry_date, p.entry_number, p.description, p.reference,
    p.source_type, p.source_id, p.status, COALESCE(p.is_reversal, false),
    orig.entry_number, jb.name, br.name, p.currency,
    jel.id, a.code, a.name, jel.description,
    COALESCE(jel.debit, 0), COALESCE(jel.credit, 0), v_total,
    jel.original_debit, jel.original_credit,
    COALESCE(jel.exchange_rate, p.exchange_rate)
  FROM page p
  JOIN public.journal_entry_lines jel ON jel.journal_entry_id = p.id
  LEFT JOIN public.accounts a ON a.id = jel.account_id
  LEFT JOIN public.journal_entries orig ON orig.id = p.reversal_of_id
  LEFT JOIN public.journal_books jb ON jb.id = p.journal_book_id
  LEFT JOIN public.branches br ON br.id = p.branch_id
  ORDER BY p.entry_date DESC, p.entry_number DESC, a.code NULLS LAST, jel.id;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_general_ledger(uuid, date, date, uuid, uuid[], boolean, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_general_ledger(uuid, date, date, uuid, uuid[], boolean, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.get_journal_report(uuid, date, date, uuid, uuid, text[], integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_journal_report(uuid, date, date, uuid, uuid, text[], integer, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_general_ledger(uuid, date, date, uuid, uuid[], boolean, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_journal_report(uuid, date, date, uuid, uuid, text[], integer, integer) TO authenticated, service_role;