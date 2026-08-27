CREATE OR REPLACE FUNCTION public.consolidation_intercompany_balances(
  _group_id uuid,
  _date_from date,
  _date_to date
)
RETURNS TABLE (
  group_id uuid,
  presentation_currency text,
  relation text,
  declaring_business_id uuid,
  declaring_business_name text,
  declaring_base_currency text,
  declaring_closing_rate numeric,
  counterparty_business_id uuid,
  counterparty_business_name text,
  counterparty_base_currency text,
  counterparty_closing_rate numeric,
  declaring_amount_base numeric,
  declaring_amount numeric,
  counterparty_amount_base numeric,
  counterparty_amount numeric,
  difference numeric,
  declaring_contacts integer,
  counterparty_contacts integer
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_group public.consolidation_groups;
  v_blocker text;
  v_bad record;
BEGIN
  IF _group_id IS NULL OR _date_from IS NULL OR _date_to IS NULL THEN
    RAISE EXCEPTION 'consolidation_intercompany_balances: group and date range are required';
  END IF;
  IF _date_to < _date_from THEN
    RAISE EXCEPTION 'consolidation_intercompany_balances: date_to must not precede date_from';
  END IF;

  SELECT * INTO v_group FROM public.consolidation_groups g WHERE g.id = _group_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Consolidation group not found or not visible to you' USING ERRCODE = '42501';
  END IF;

  -- Same scope gate as every other consolidation report: a hidden or blocked
  -- member refuses the run instead of quietly shrinking the group.
  SELECT s.blocker INTO v_blocker
    FROM public.resolve_consolidation_scope(_group_id, _date_to) s
   WHERE s.blocker IS NOT NULL
   LIMIT 1;
  IF v_blocker IS NOT NULL THEN
    RAISE EXCEPTION 'Consolidation scope is not reportable: %', v_blocker USING ERRCODE = '42501';
  END IF;

  -- Monetary intercompany positions translate at the closing rate (IAS 21.23(a)).
  -- A member whose currency has no closing rate on file refuses the report.
  SELECT s.business_name, s.base_currency INTO v_bad
    FROM public.resolve_consolidation_scope(_group_id, _date_to) s
    LEFT JOIN LATERAL public.consolidation_member_translation_rates(
                _group_id, s.business_id, _date_from, _date_to) r ON true
   WHERE s.requires_translation AND r.closing_rate IS NULL
   LIMIT 1;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'No %->% closing rate on file for % at %; intercompany balances are refused rather than approximated',
      v_bad.base_currency, v_group.presentation_currency, v_bad.business_name, _date_to
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH member_rates AS (
    SELECT s.business_id,
           s.business_name,
           s.base_currency,
           CASE WHEN s.requires_translation THEN r.closing_rate ELSE 1 END AS closing_rate
      FROM public.resolve_consolidation_scope(_group_id, _date_to) s
      LEFT JOIN LATERAL public.consolidation_member_translation_rates(
                  _group_id, s.business_id, _date_from, _date_to) r ON true
  ),
  links AS (
    SELECT p.business_id, p.contact_id, p.counterparty_business_id
      FROM public.consolidation_intercompany_partners p
     WHERE p.group_id = _group_id
       AND p.effective_from <= _date_to
       AND (p.effective_to IS NULL OR p.effective_to >= _date_from)
  ),
  -- Receivable position of the declaring company against the counterparty
  -- (debit-normal), from the authoritative AR sub-ledger.
  ar AS (
    SELECT l.business_id, l.counterparty_business_id,
           COALESCE(SUM(e.debit - e.credit), 0) AS amount_base,
           COUNT(DISTINCT l.contact_id)::int AS contacts
      FROM links l
      JOIN public.customer_ledger_entries e
        ON e.contact_id = l.contact_id
       AND e.business_id = l.business_id
       AND e.entry_date <= _date_to
     GROUP BY l.business_id, l.counterparty_business_id
  ),
  -- Payable position (credit-normal), from the authoritative AP sub-ledger.
  ap AS (
    SELECT l.business_id, l.counterparty_business_id,
           COALESCE(SUM(e.credit - e.debit), 0) AS amount_base,
           COUNT(DISTINCT l.contact_id)::int AS contacts
      FROM links l
      JOIN public.vendor_ledger_entries e
        ON e.contact_id = l.contact_id
       AND e.business_id = l.business_id
       AND e.entry_date <= _date_to
     GROUP BY l.business_id, l.counterparty_business_id
  ),
  pairs AS (
    SELECT DISTINCT l.business_id AS a, l.counterparty_business_id AS b FROM links l
  )
  SELECT _group_id,
         v_group.presentation_currency,
         'due_from'::text,
         pr.a,
         ra.business_name,
         ra.base_currency,
         ra.closing_rate,
         pr.b,
         rb.business_name,
         rb.base_currency,
         rb.closing_rate,
         COALESCE(ar.amount_base, 0),
         round(COALESCE(ar.amount_base, 0) * ra.closing_rate, 2),
         COALESCE(ap.amount_base, 0),
         round(COALESCE(ap.amount_base, 0) * rb.closing_rate, 2),
         round(COALESCE(ar.amount_base, 0) * ra.closing_rate, 2)
           - round(COALESCE(ap.amount_base, 0) * rb.closing_rate, 2),
         COALESCE(ar.contacts, 0),
         COALESCE(ap.contacts, 0)
    FROM pairs pr
    JOIN member_rates ra ON ra.business_id = pr.a
    JOIN member_rates rb ON rb.business_id = pr.b
    LEFT JOIN ar ON ar.business_id = pr.a AND ar.counterparty_business_id = pr.b
    -- the mirror side: what the counterparty says it owes the declaring company
    LEFT JOIN ap ON ap.business_id = pr.b AND ap.counterparty_business_id = pr.a
   WHERE COALESCE(ar.amount_base, 0) <> 0 OR COALESCE(ap.amount_base, 0) <> 0
   ORDER BY 5, 9;
END;
$$;

REVOKE ALL ON FUNCTION public.consolidation_intercompany_balances(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.consolidation_intercompany_balances(uuid, date, date) TO authenticated, service_role;
