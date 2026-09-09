CREATE OR REPLACE FUNCTION public.reset_module__transactions_ledger(org_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v jsonb := '{}'::jsonb; n bigint;
BEGIN
  IF to_regclass('public.payment_allocations') IS NOT NULL THEN
    EXECUTE format('WITH d AS (DELETE FROM payment_allocations a USING payments p WHERE a.payment_id = p.id AND p.organization_id=%L RETURNING 1) SELECT count(*) FROM d', org_id) INTO n;
    v := v || jsonb_build_object('payment_allocations', n);
  END IF;
  IF to_regclass('public.payments') IS NOT NULL THEN
    EXECUTE format('WITH d AS (DELETE FROM payments WHERE organization_id=%L RETURNING 1) SELECT count(*) FROM d', org_id) INTO n;
    v := v || jsonb_build_object('payments', n);
  END IF;
  IF to_regclass('public.fx_revaluation_lines') IS NOT NULL THEN
    EXECUTE format('WITH d AS (DELETE FROM fx_revaluation_lines l USING fx_revaluation_runs r WHERE l.run_id = r.id AND r.organization_id=%L RETURNING 1) SELECT count(*) FROM d', org_id) INTO n;
    v := v || jsonb_build_object('fx_revaluation_lines', n);
  END IF;
  IF to_regclass('public.fx_revaluation_runs') IS NOT NULL THEN
    EXECUTE format('WITH d AS (DELETE FROM fx_revaluation_runs WHERE organization_id=%L RETURNING 1) SELECT count(*) FROM d', org_id) INTO n;
    v := v || jsonb_build_object('fx_revaluation_runs', n);
  END IF;
  IF to_regclass('public.accounting_events') IS NOT NULL THEN
    EXECUTE format('WITH d AS (DELETE FROM accounting_events e USING businesses b WHERE e.business_id = b.id AND b.organization_id=%L RETURNING 1) SELECT count(*) FROM d', org_id) INTO n;
    v := v || jsonb_build_object('accounting_events', n);
  END IF;
  IF to_regclass('public.transactions') IS NOT NULL THEN
    EXECUTE format('WITH d AS (DELETE FROM transactions WHERE organization_id=%L RETURNING 1) SELECT count(*) FROM d', org_id) INTO n;
    v := v || jsonb_build_object('transactions', n);
  END IF;
  RETURN v;
END;
$function$;