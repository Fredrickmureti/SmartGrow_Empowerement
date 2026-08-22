-- Phase 4 — Journal Report gets a real server-side engine.
-- The client previously selected journal_entries directly, so it silently
-- truncated at PostgREST's 1000-row limit (totals then quietly wrong) and
-- used a loose `branch = X OR branch IS NULL` filter that disagreed with
-- the Trial Balance / General Ledger strict scoping.
CREATE OR REPLACE FUNCTION public.get_journal_report(
  _org_id uuid,
  _date_from date,
  _date_to date,
  _business_id uuid DEFAULT NULL,
  _branch_id uuid DEFAULT NULL,
  _source_types text[] DEFAULT NULL,
  _limit integer DEFAULT 500,
  _offset integer DEFAULT 0
)
RETURNS TABLE(
  entry_id uuid,
  entry_date date,
  entry_number text,
  je_description text,
  reference text,
  source_type text,
  source_id uuid,
  entry_status text,
  is_reversal boolean,
  reversal_of_number text,
  journal_book text,
  branch_name text,
  entry_currency text,
  line_id uuid,
  account_code text,
  account_name text,
  line_description text,
  debit numeric,
  credit numeric,
  total_entries bigint
)
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

  CREATE TEMP TABLE IF NOT EXISTS _jr_scope_dummy() ON COMMIT DROP;

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
    p.id,
    p.entry_date,
    p.entry_number,
    p.description,
    p.reference,
    p.source_type,
    p.source_id,
    p.status,
    COALESCE(p.is_reversal, false),
    orig.entry_number,
    jb.name,
    br.name,
    p.currency,
    jel.id,
    a.code,
    a.name,
    jel.description,
    COALESCE(jel.debit, 0),
    COALESCE(jel.credit, 0),
    v_total
  FROM page p
  JOIN public.journal_entry_lines jel ON jel.journal_entry_id = p.id
  LEFT JOIN public.accounts a ON a.id = jel.account_id
  LEFT JOIN public.journal_entries orig ON orig.id = p.reversal_of_id
  LEFT JOIN public.journal_books jb ON jb.id = p.journal_book_id
  LEFT JOIN public.branches br ON br.id = p.branch_id
  ORDER BY p.entry_date DESC, p.entry_number DESC, a.code NULLS LAST, jel.id;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_journal_report(uuid, date, date, uuid, uuid, text[], integer, integer) TO authenticated, service_role;