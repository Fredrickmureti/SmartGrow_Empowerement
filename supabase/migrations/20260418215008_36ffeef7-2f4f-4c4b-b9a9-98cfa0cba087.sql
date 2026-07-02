CREATE OR REPLACE FUNCTION public.get_control_account_reconciliation(
  _org_id uuid,
  _business_id uuid DEFAULT NULL::uuid,
  _report_type text DEFAULT 'ar'::text
)
RETURNS TABLE(
  control_account_id uuid,
  sub_ledger_total numeric,
  gl_closing numeric,
  opening_balance numeric,
  has_migration_je boolean,
  drift numeric,
  has_drift boolean
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_setting_key text;
  v_legacy_key text;
  v_control_account_id uuid;
  v_opening_balance numeric := 0;
  v_je_balance numeric := 0;
  v_sub_ledger_total numeric := 0;
  v_has_migration_je boolean := false;
  v_gl_closing numeric := 0;
  v_drift numeric := 0;
BEGIN
  -- Pick the right setting key for the report type.
  IF _report_type = 'ar' THEN
    v_setting_key := 'accounts_receivable';
    v_legacy_key  := 'accounts_receivable';
  ELSE
    v_setting_key := 'accounts_payable';
    v_legacy_key  := 'accounts_payable';
  END IF;

  -- 1) Explicit settings (the table Finance Settings actually writes to).
  --    Prefer business-scoped row over org-scoped (null business_id).
  SELECT account_id
    INTO v_control_account_id
  FROM default_account_settings
  WHERE organization_id = _org_id
    AND setting_key = v_setting_key
    AND (
      (_business_id IS NOT NULL AND business_id = _business_id)
      OR business_id IS NULL
    )
  ORDER BY (business_id IS NOT NULL) DESC NULLS LAST
  LIMIT 1;

  -- 2) Legacy mappings table fallback.
  IF v_control_account_id IS NULL THEN
    SELECT account_id
      INTO v_control_account_id
    FROM default_account_mappings
    WHERE organization_id = _org_id
      AND mapping_type = v_legacy_key
      AND (
        (_business_id IS NOT NULL AND business_id = _business_id)
        OR business_id IS NULL
      )
    ORDER BY (business_id IS NOT NULL) DESC NULLS LAST
    LIMIT 1;
  END IF;

  IF v_control_account_id IS NULL THEN
    RETURN QUERY SELECT NULL::uuid, 0::numeric, 0::numeric, 0::numeric, false, 0::numeric, false;
    RETURN;
  END IF;

  -- Opening balance from accounts table.
  SELECT COALESCE(opening_balance, 0)
    INTO v_opening_balance
  FROM accounts
  WHERE id = v_control_account_id;

  -- Detect a migration / opening-balance JE touching this control account.
  SELECT EXISTS (
    SELECT 1
    FROM journal_entries je
    JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
    WHERE je.organization_id = _org_id
      AND je.status = 'posted'
      AND jel.account_id = v_control_account_id
      AND (
        je.description ILIKE '%opening balance%'
        OR je.description ILIKE '%migration%'
        OR je.reference ILIKE '%opening%'
        OR je.reference ILIKE '%migration%'
      )
  ) INTO v_has_migration_je;

  -- JE-derived balance (sign convention matches account type).
  IF _report_type = 'ar' THEN
    SELECT COALESCE(SUM(jel.debit - jel.credit), 0)
      INTO v_je_balance
    FROM journal_entry_lines jel
    JOIN journal_entries je ON je.id = jel.journal_entry_id
    WHERE jel.account_id = v_control_account_id
      AND je.organization_id = _org_id
      AND je.status = 'posted'
      AND (_business_id IS NULL OR je.business_id = _business_id);
  ELSE
    SELECT COALESCE(SUM(jel.credit - jel.debit), 0)
      INTO v_je_balance
    FROM journal_entry_lines jel
    JOIN journal_entries je ON je.id = jel.journal_entry_id
    WHERE jel.account_id = v_control_account_id
      AND je.organization_id = _org_id
      AND je.status = 'posted'
      AND (_business_id IS NULL OR je.business_id = _business_id);
  END IF;

  -- Migration-aware GL closing.
  IF v_has_migration_je THEN
    v_gl_closing := v_je_balance;
  ELSE
    v_gl_closing := v_opening_balance + v_je_balance;
  END IF;

  -- Sub-ledger total: open invoices / bills.
  IF _report_type = 'ar' THEN
    SELECT COALESCE(SUM(GREATEST(COALESCE(i.total, 0) - COALESCE(i.amount_paid, 0), 0)), 0)
      INTO v_sub_ledger_total
    FROM invoices i
    WHERE i.organization_id = _org_id
      AND i.status::text NOT IN ('draft','paid','cancelled','voided')
      AND (_business_id IS NULL OR i.business_id = _business_id);
  ELSE
    SELECT COALESCE(SUM(GREATEST(COALESCE(b.total, 0) - COALESCE(b.amount_paid, 0), 0)), 0)
      INTO v_sub_ledger_total
    FROM bills b
    WHERE b.organization_id = _org_id
      AND b.status::text NOT IN ('draft','paid','void')
      AND (_business_id IS NULL OR b.business_id = _business_id);
  END IF;

  v_drift := v_sub_ledger_total - v_gl_closing;

  RETURN QUERY SELECT
    v_control_account_id,
    v_sub_ledger_total,
    v_gl_closing,
    v_opening_balance,
    v_has_migration_je,
    v_drift,
    (ABS(v_drift) > 0.01);
END;
$function$;