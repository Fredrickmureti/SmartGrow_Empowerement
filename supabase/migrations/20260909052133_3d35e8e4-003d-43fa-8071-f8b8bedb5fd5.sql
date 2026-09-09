CREATE OR REPLACE FUNCTION public.reset_module__banking(org_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v jsonb := '{}'::jsonb; n bigint;
BEGIN
  IF to_regclass('public.bank_reconciliation_writeoffs') IS NOT NULL THEN
    EXECUTE format('WITH d AS (DELETE FROM bank_reconciliation_writeoffs w USING bank_reconciliation_matches m WHERE w.reconciliation_match_id = m.id AND m.organization_id=%L RETURNING 1) SELECT count(*) FROM d', org_id) INTO n;
    v := v || jsonb_build_object('bank_reconciliation_writeoffs', n);
  END IF;
  IF to_regclass('public.bank_reconciliation_items') IS NOT NULL THEN
    EXECUTE format('WITH d AS (DELETE FROM bank_reconciliation_items i USING bank_reconciliation_sessions s WHERE i.session_id = s.id AND s.organization_id=%L RETURNING 1) SELECT count(*) FROM d', org_id) INTO n;
    v := v || jsonb_build_object('bank_reconciliation_items', n);
  END IF;
  IF to_regclass('public.bank_reconciliation_matches') IS NOT NULL THEN
    EXECUTE format('WITH d AS (DELETE FROM bank_reconciliation_matches WHERE organization_id=%L RETURNING 1) SELECT count(*) FROM d', org_id) INTO n;
    v := v || jsonb_build_object('bank_reconciliation_matches', n);
  END IF;
  IF to_regclass('public.bank_reconciliation_sessions') IS NOT NULL THEN
    EXECUTE format('UPDATE bank_reconciliation_sessions SET writeoff_je_id = NULL WHERE organization_id=%L AND writeoff_je_id IS NOT NULL', org_id);
    EXECUTE format('WITH d AS (DELETE FROM bank_reconciliation_sessions WHERE organization_id=%L RETURNING 1) SELECT count(*) FROM d', org_id) INTO n;
    v := v || jsonb_build_object('bank_reconciliation_sessions', n);
  END IF;
  IF to_regclass('public.bank_transactions') IS NOT NULL THEN
    EXECUTE format('WITH d AS (DELETE FROM bank_transactions WHERE organization_id=%L RETURNING 1) SELECT count(*) FROM d', org_id) INTO n;
    v := v || jsonb_build_object('bank_transactions', n);
  END IF;
  IF to_regclass('public.bank_statements') IS NOT NULL THEN
    EXECUTE format('WITH d AS (DELETE FROM bank_statements WHERE organization_id=%L RETURNING 1) SELECT count(*) FROM d', org_id) INTO n;
    v := v || jsonb_build_object('bank_statements', n);
  END IF;
  RETURN v;
END;
$function$;