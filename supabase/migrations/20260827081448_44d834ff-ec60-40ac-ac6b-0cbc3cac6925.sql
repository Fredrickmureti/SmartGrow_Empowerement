-- Brick 6, step 2: the honesty gate.
--
-- Declarations are the only source of intercompany truth, which means the
-- system's blind spot is a relationship nobody declared: the balance simply
-- looks like third-party trade and the consolidated statements silently
-- overstate revenue, receivables and payables. This function makes that blind
-- spot visible instead of leaving it to memory — it lists member activity
-- against contacts that carry NO declaration for the period.
--
-- It never asserts that an undeclared contact IS a group company. It reports
-- the activity, and where the contact's tax number or registration number is
-- byte-identical to a member company's own legal identifier it offers that
-- member as a *suggestion*, saying which identifier matched. Name similarity is
-- deliberately not used: a name is not an identity.
--
-- Amounts stay in each member's functional currency and are not translated. A
-- worklist must never be blocked by a missing rate, and no figure here is
-- reported anywhere.
CREATE OR REPLACE FUNCTION public.consolidation_intercompany_coverage(
  _group_id uuid,
  _date_from date,
  _date_to date
)
RETURNS TABLE (
  group_id uuid,
  business_id uuid,
  business_name text,
  base_currency text,
  contact_id uuid,
  contact_name text,
  contact_type contact_type,
  contact_tax_id text,
  gl_line_count integer,
  gl_debit_base numeric,
  gl_credit_base numeric,
  gl_net_base numeric,
  receivable_base numeric,
  payable_base numeric,
  first_activity date,
  last_activity date,
  suggested_counterparty_business_id uuid,
  suggested_counterparty_business_name text,
  suggestion_basis text
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_group public.consolidation_groups;
  v_blocker text;
BEGIN
  IF _group_id IS NULL OR _date_from IS NULL OR _date_to IS NULL THEN
    RAISE EXCEPTION 'consolidation_intercompany_coverage: group and date range are required';
  END IF;
  IF _date_to < _date_from THEN
    RAISE EXCEPTION 'consolidation_intercompany_coverage: date_to must not precede date_from';
  END IF;

  SELECT * INTO v_group FROM public.consolidation_groups g WHERE g.id = _group_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Consolidation group not found or not visible to you' USING ERRCODE = '42501';
  END IF;

  -- A worklist built over a partial group would understate the gap, so the same
  -- scope gate as every other consolidation report applies.
  SELECT s.blocker INTO v_blocker
    FROM public.resolve_consolidation_scope(_group_id, _date_to) s
   WHERE s.blocker IS NOT NULL
   LIMIT 1;
  IF v_blocker IS NOT NULL THEN
    RAISE EXCEPTION 'Consolidation scope is not reportable: %', v_blocker USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH scope AS (
    SELECT s.business_id, s.business_name, s.base_currency
      FROM public.resolve_consolidation_scope(_group_id, _date_to) s
  ),
  declared AS (
    SELECT p.business_id, p.contact_id
      FROM public.consolidation_intercompany_partners p
     WHERE p.group_id = _group_id
       AND p.effective_from <= _date_to
       AND (p.effective_to IS NULL OR p.effective_to >= _date_from)
  ),
  gl AS (
    SELECT jl.business_id,
           jl.contact_id,
           COUNT(*)::int AS line_count,
           SUM(jl.debit)  AS debit_base,
           SUM(jl.credit) AS credit_base,
           MIN(je.entry_date) AS first_activity,
           MAX(je.entry_date) AS last_activity
      FROM public.journal_entry_lines jl
      JOIN public.journal_entries je
        ON je.id = jl.journal_entry_id
       AND je.business_id = jl.business_id
       AND je.status = 'posted'
       AND je.entry_date BETWEEN _date_from AND _date_to
     WHERE jl.contact_id IS NOT NULL
       AND jl.business_id IN (SELECT s.business_id FROM scope s)
     GROUP BY jl.business_id, jl.contact_id
  ),
  ar AS (
    SELECT e.business_id, e.contact_id, SUM(e.debit - e.credit) AS amount_base
      FROM public.customer_ledger_entries e
     WHERE e.business_id IN (SELECT s.business_id FROM scope s)
       AND e.entry_date BETWEEN _date_from AND _date_to
     GROUP BY e.business_id, e.contact_id
  ),
  ap AS (
    SELECT e.business_id, e.contact_id, SUM(e.credit - e.debit) AS amount_base
      FROM public.vendor_ledger_entries e
     WHERE e.business_id IN (SELECT s.business_id FROM scope s)
       AND e.entry_date BETWEEN _date_from AND _date_to
     GROUP BY e.business_id, e.contact_id
  ),
  activity AS (
    SELECT COALESCE(gl.business_id, ar.business_id, ap.business_id) AS business_id,
           COALESCE(gl.contact_id, ar.contact_id, ap.contact_id)   AS contact_id,
           COALESCE(gl.line_count, 0)  AS line_count,
           COALESCE(gl.debit_base, 0)  AS debit_base,
           COALESCE(gl.credit_base, 0) AS credit_base,
           COALESCE(ar.amount_base, 0) AS receivable_base,
           COALESCE(ap.amount_base, 0) AS payable_base,
           gl.first_activity,
           gl.last_activity
      FROM gl
      FULL JOIN ar ON ar.business_id = gl.business_id AND ar.contact_id = gl.contact_id
      FULL JOIN ap ON ap.business_id = COALESCE(gl.business_id, ar.business_id)
                  AND ap.contact_id  = COALESCE(gl.contact_id, ar.contact_id)
  )
  SELECT _group_id,
         s.business_id,
         s.business_name,
         s.base_currency,
         c.id,
         c.name,
         c.type,
         c.tax_id,
         a.line_count,
         a.debit_base,
         a.credit_base,
         a.debit_base - a.credit_base,
         a.receivable_base,
         a.payable_base,
         a.first_activity,
         a.last_activity,
         m.business_id,
         m.business_name,
         m.basis
    FROM activity a
    JOIN scope s ON s.business_id = a.business_id
    JOIN public.contacts c ON c.id = a.contact_id
    -- suggestion only from a legal identifier, and only from another member
    LEFT JOIN LATERAL (
      SELECT s2.business_id, s2.business_name, x.basis
        FROM scope s2
        JOIN public.businesses b2 ON b2.id = s2.business_id
        CROSS JOIN LATERAL (
          SELECT CASE
                   WHEN NULLIF(btrim(c.tax_id), '') IS NOT NULL
                        AND btrim(c.tax_id) = btrim(b2.tax_id) THEN 'tax_id'
                   WHEN NULLIF(btrim(c.tax_id), '') IS NOT NULL
                        AND btrim(c.tax_id) = btrim(b2.registration_number) THEN 'registration_number'
                 END AS basis
        ) x
       WHERE s2.business_id <> s.business_id
         AND x.basis IS NOT NULL
       LIMIT 1
    ) m ON true
   WHERE NOT EXISTS (
           SELECT 1 FROM declared d
            WHERE d.business_id = a.business_id AND d.contact_id = a.contact_id
         )
     AND (a.line_count > 0 OR a.receivable_base <> 0 OR a.payable_base <> 0)
   ORDER BY (m.business_id IS NOT NULL) DESC,
            abs(a.receivable_base) + abs(a.payable_base) + abs(a.debit_base - a.credit_base) DESC,
            s.business_name, c.name;
END;
$$;

REVOKE ALL ON FUNCTION public.consolidation_intercompany_coverage(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.consolidation_intercompany_coverage(uuid, date, date) TO authenticated, service_role;