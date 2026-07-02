CREATE OR REPLACE FUNCTION public.reset_module__finance(org_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v jsonb := '{}'::jsonb; n bigint;
BEGIN
  UPDATE journal_entries
     SET reversed_entry_id = NULL
   WHERE organization_id = org_id
     AND reversed_entry_id IS NOT NULL;

  -- Unlink payroll GL references (no ON DELETE SET NULL on these FKs)
  IF to_regclass('public.payroll_liabilities') IS NOT NULL THEN
    UPDATE public.payroll_liabilities
       SET journal_entry_id = NULL
     WHERE organization_id = org_id
       AND journal_entry_id IS NOT NULL;
  END IF;

  IF to_regclass('public.payroll_remittance_payments') IS NOT NULL THEN
    UPDATE public.payroll_remittance_payments
       SET journal_entry_id = NULL
     WHERE organization_id = org_id
       AND journal_entry_id IS NOT NULL;
  END IF;

  WITH d AS (DELETE FROM journal_entry_lines
              WHERE journal_entry_id IN (SELECT id FROM journal_entries WHERE organization_id=org_id)
              RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('journal_entry_lines', n);

  WITH d AS (DELETE FROM journal_entries WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
  v := v || jsonb_build_object('journal_entries', n);

  WITH u AS (
    UPDATE accounts
       SET current_balance = 0, updated_at = now()
     WHERE organization_id = org_id AND current_balance IS DISTINCT FROM 0
     RETURNING 1
  ) SELECT count(*) INTO n FROM u;
  v := v || jsonb_build_object('accounts_balance_zeroed', n);

  RETURN v;
END;
$function$;