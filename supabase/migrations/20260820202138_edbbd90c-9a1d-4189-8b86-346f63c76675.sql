-- ============================================================================
-- Cash & Banking reporting hardening — Phase 1 (security)
--
-- Defect: the GL reporting RPCs below are SECURITY DEFINER (so they bypass
-- RLS) and are EXECUTE-able by `authenticated`, but they only validated that
-- the *passed* business/branch belonged to the *passed* organisation. None of
-- them verified that the CALLER is a member of that organisation, so any
-- signed-in user could pass a foreign organization_id and read that tenant's
-- posted GL activity — including cash and bank accounts.
--
-- Fix: apply the canonical caller gate `public.finance_can_read_org(_org_id)`
-- already used by get_control_account_reconciliation, get_ap_aging_summary,
-- get_ar_ap_aging_from_ledger and the sales/purchase analysis engines.
-- Bodies are otherwise unchanged. Two SQL-language functions are converted to
-- plpgsql purely so the gate can RAISE 42501 (same query, same result shape).
-- ============================================================================

-- 1. get_account_movements ---------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_account_movements(
  _org_id uuid, _date_from date, _date_to date,
  _business_id uuid DEFAULT NULL::uuid, _branch_id uuid DEFAULT NULL::uuid
)
RETURNS TABLE(account_id uuid, total_debit numeric, total_credit numeric)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF _org_id IS NULL THEN
    RAISE EXCEPTION 'get_account_movements: _org_id is required';
  END IF;

  IF NOT public.finance_can_read_org(_org_id) THEN
    RAISE EXCEPTION 'Not authorized for this organization' USING ERRCODE = '42501';
  END IF;

  IF _business_id IS NOT NULL THEN
    PERFORM 1
      FROM public.businesses b
      WHERE b.id = _business_id AND b.organization_id = _org_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'get_account_movements: business % does not belong to org %', _business_id, _org_id;
    END IF;
  END IF;

  IF _branch_id IS NOT NULL THEN
    PERFORM 1
      FROM public.branches br
      WHERE br.id = _branch_id
        AND br.organization_id = _org_id
        AND (_business_id IS NULL OR br.business_id = _business_id);
    IF NOT FOUND THEN
      RAISE EXCEPTION 'get_account_movements: branch % does not belong to org % / business %', _branch_id, _org_id, _business_id;
    END IF;
  END IF;

  RETURN QUERY
  SELECT
    jel.account_id,
    COALESCE(SUM(jel.debit), 0)::numeric  AS total_debit,
    COALESCE(SUM(jel.credit), 0)::numeric AS total_credit
  FROM public.journal_entry_lines jel
  JOIN public.journal_entries je ON je.id = jel.journal_entry_id
  WHERE je.organization_id = _org_id
    AND je.status = 'posted'
    AND je.entry_date BETWEEN _date_from AND _date_to
    AND (_business_id IS NULL OR je.business_id = _business_id)
    AND (_branch_id   IS NULL OR je.branch_id   = _branch_id)
  GROUP BY jel.account_id;
END;
$function$;

-- 2. get_general_ledger ------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_general_ledger(
  _org_id uuid, _date_from date, _date_to date,
  _business_id uuid DEFAULT NULL::uuid, _account_ids uuid[] DEFAULT NULL::uuid[],
  _include_zero_activity boolean DEFAULT false, _branch_id uuid DEFAULT NULL::uuid
)
RETURNS TABLE(account_id uuid, account_code text, account_name text, account_type text, opening_balance numeric, line_id uuid, entry_date date, entry_number text, je_description text, line_description text, reference text, debit numeric, credit numeric, source_type text, source_id uuid, contact_name text)
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
    PERFORM 1
      FROM public.businesses b
      WHERE b.id = _business_id AND b.organization_id = _org_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'get_general_ledger: business % does not belong to org %', _business_id, _org_id;
    END IF;
  END IF;

  IF _branch_id IS NOT NULL THEN
    PERFORM 1
      FROM public.branches br
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
      -- Hardened: accounts.business_id is NOT NULL. Strict scope, no NULL leak.
      AND (_business_id IS NULL OR a.business_id = _business_id)
      AND (_account_ids IS NULL OR a.id = ANY(_account_ids))
  ),
  prior AS (
    -- Prior-period movement, aggregated as raw debit/credit totals. The
    -- natural-direction signing happens below, per account type, so that the
    -- carried-forward opening balance uses the SAME convention as the period
    -- movement added by the consumers (accountingKernel.calculateBalance) and
    -- as the trial balance / server PDF engine.
    SELECT jel.account_id,
           COALESCE(SUM(jel.debit), 0)  AS prior_debit,
           COALESCE(SUM(jel.credit), 0) AS prior_credit
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id = jel.journal_entry_id
    WHERE je.organization_id = _org_id
      AND je.status = 'posted'
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
      c.name AS contact_name
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id = jel.journal_entry_id
    LEFT JOIN public.contacts c ON c.id = jel.contact_id
    WHERE je.organization_id = _org_id
      AND je.status = 'posted'
      AND je.entry_date BETWEEN _date_from AND _date_to
      AND (_business_id IS NULL OR je.business_id = _business_id)
      AND (_branch_id   IS NULL OR je.branch_id   = _branch_id)
  ),
  scoped AS (
    SELECT
      s.id, s.code, s.name, s.account_type,
      -- accounts.opening_balance is stored natural-signed (see
      -- migrate_opening_balances_to_je), so prior movement is signed the same way.
      s.opening_balance
        + CASE
            WHEN s.account_type IN ('asset', 'expense')
              THEN COALESCE(p.prior_debit, 0) - COALESCE(p.prior_credit, 0)
            ELSE COALESCE(p.prior_credit, 0) - COALESCE(p.prior_debit, 0)
          END AS opening_balance_natural,
      pl.line_id, pl.entry_date, pl.entry_number,
      pl.je_description, pl.line_description, pl.reference,
      pl.debit, pl.credit, pl.source_type, pl.source_id, pl.contact_name
    FROM scope s
    LEFT JOIN prior p ON p.account_id = s.id
    LEFT JOIN period_lines pl ON pl.account_id = s.id
  )
  SELECT
    sc.id, sc.code, sc.name, sc.account_type,
    sc.opening_balance_natural,
    sc.line_id, sc.entry_date, sc.entry_number,
    sc.je_description, sc.line_description, sc.reference,
    sc.debit, sc.credit, sc.source_type, sc.source_id, sc.contact_name
  FROM scoped sc
  WHERE _include_zero_activity
     OR sc.line_id IS NOT NULL
     OR sc.opening_balance_natural <> 0
  ORDER BY sc.code, sc.entry_date NULLS FIRST, sc.entry_number NULLS FIRST, sc.line_id NULLS FIRST;
END;
$function$;

-- 3. get_account_balances (SQL -> plpgsql so the gate can raise) -------------
CREATE OR REPLACE FUNCTION public.get_account_balances(
  _org_id uuid, _business_id uuid, _branch_id uuid DEFAULT NULL::uuid
)
RETURNS TABLE(account_id uuid, total_debit numeric, total_credit numeric, net_balance numeric)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.finance_can_read_org(_org_id) THEN
    RAISE EXCEPTION 'Not authorized for this organization' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    l.account_id,
    COALESCE(SUM(l.debit),  0) AS total_debit,
    COALESCE(SUM(l.credit), 0) AS total_credit,
    COALESCE(SUM(l.debit), 0) - COALESCE(SUM(l.credit), 0) AS net_balance
  FROM public.journal_entry_lines l
  JOIN public.journal_entries je ON je.id = l.journal_entry_id
  WHERE je.organization_id = _org_id
    AND je.business_id = _business_id
    AND je.status = 'posted'
    AND (_branch_id IS NULL OR l.branch_id = _branch_id)
  GROUP BY l.account_id;
END;
$function$;

-- 4. get_gl_transactions (SQL -> plpgsql so the gate can raise) --------------
CREATE OR REPLACE FUNCTION public.get_gl_transactions(
  _org_id uuid, _date_from date, _date_to date, _account_ids uuid[],
  _branch_id uuid DEFAULT NULL::uuid
)
RETURNS TABLE(entry_id uuid, entry_number text, entry_date date, reference text, description text, account_id uuid, debit numeric, credit numeric, branch_id uuid)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.finance_can_read_org(_org_id) THEN
    RAISE EXCEPTION 'Not authorized for this organization' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    je.id           AS entry_id,
    je.entry_number,
    je.entry_date,
    je.reference,
    je.description,
    l.account_id,
    l.debit,
    l.credit,
    l.branch_id
  FROM public.journal_entry_lines l
  JOIN public.journal_entries je ON je.id = l.journal_entry_id
  WHERE je.organization_id = _org_id
    AND je.status = 'posted'
    AND je.entry_date BETWEEN _date_from AND _date_to
    AND (_account_ids IS NULL OR l.account_id = ANY(_account_ids))
    AND (_branch_id IS NULL OR l.branch_id = _branch_id)
  ORDER BY je.entry_date, je.entry_number;
END;
$function$;

-- 5. check_balance_integrity (SQL -> plpgsql so the gate can raise) ----------
CREATE OR REPLACE FUNCTION public.check_balance_integrity(
  _org_id uuid, _business_id uuid DEFAULT NULL::uuid
)
RETURNS TABLE(account_id uuid, business_id uuid, account_code text, account_name text, stored_balance numeric, ledger_balance numeric, drift numeric)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.finance_can_read_org(_org_id) THEN
    RAISE EXCEPTION 'Not authorized for this organization' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH ledger AS (
    SELECT jel.account_id,
      je.business_id,
      SUM(CASE WHEN acct.account_type IN ('asset','expense')
        THEN COALESCE(jel.debit,0) - COALESCE(jel.credit,0)
        ELSE COALESCE(jel.credit,0) - COALESCE(jel.debit,0)
      END) AS balance
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id = jel.journal_entry_id
    JOIN public.accounts acct ON acct.id = jel.account_id
    WHERE je.organization_id = _org_id
      AND je.status = 'posted'
      AND (_business_id IS NULL OR je.business_id = _business_id)
    GROUP BY jel.account_id, je.business_id
  )
  SELECT a.id AS account_id,
         a.business_id,
         a.code AS account_code,
         a.name AS account_name,
         COALESCE(a.current_balance, 0) AS stored_balance,
         COALESCE(l.balance, 0) AS ledger_balance,
         COALESCE(a.current_balance, 0) - COALESCE(l.balance, 0) AS drift
  FROM public.accounts a
  LEFT JOIN ledger l
    ON l.account_id = a.id
   AND l.business_id = a.business_id
  WHERE a.organization_id = _org_id
    AND (_business_id IS NULL OR a.business_id = _business_id)
    AND ABS(COALESCE(a.current_balance, 0) - COALESCE(l.balance, 0)) > 0.001;
END;
$function$;

-- 6. get_account_balance_at_date (account-scoped: resolve the owning org) ----
CREATE OR REPLACE FUNCTION public.get_account_balance_at_date(
  p_account_id uuid, p_as_of_date date
)
RETURNS numeric
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_balance NUMERIC;
  v_account_type TEXT;
  v_org_id UUID;
BEGIN
  SELECT account_type, organization_id
    INTO v_account_type, v_org_id
  FROM accounts WHERE id = p_account_id;

  IF v_org_id IS NULL THEN
    RETURN 0;
  END IF;

  IF NOT public.finance_can_read_org(v_org_id) THEN
    RAISE EXCEPTION 'Not authorized for this organization' USING ERRCODE = '42501';
  END IF;

  SELECT 
    COALESCE(a.opening_balance, 0) +
    CASE 
      WHEN v_account_type IN ('asset', 'expense') THEN
        COALESCE(SUM(jel.debit), 0) - COALESCE(SUM(jel.credit), 0)
      ELSE
        COALESCE(SUM(jel.credit), 0) - COALESCE(SUM(jel.debit), 0)
    END
  INTO v_balance
  FROM accounts a
  LEFT JOIN journal_entry_lines jel ON jel.account_id = a.id
  LEFT JOIN journal_entries je ON je.id = jel.journal_entry_id
    AND je.status = 'posted'
    AND je.entry_date <= p_as_of_date
  WHERE a.id = p_account_id
  GROUP BY a.id, a.opening_balance;
  
  RETURN COALESCE(v_balance, 0);
END;
$function$;

-- Grants: preserve the existing surface (authenticated + service_role only).
REVOKE ALL ON FUNCTION public.get_account_movements(uuid,date,date,uuid,uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_general_ledger(uuid,date,date,uuid,uuid[],boolean,uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_account_balances(uuid,uuid,uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_gl_transactions(uuid,date,date,uuid[],uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.check_balance_integrity(uuid,uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_account_balance_at_date(uuid,date) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.get_account_movements(uuid,date,date,uuid,uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_general_ledger(uuid,date,date,uuid,uuid[],boolean,uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_account_balances(uuid,uuid,uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_gl_transactions(uuid,date,date,uuid[],uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.check_balance_integrity(uuid,uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_account_balance_at_date(uuid,date) TO authenticated, service_role;
