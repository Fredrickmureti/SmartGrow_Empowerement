CREATE OR REPLACE FUNCTION public.__v1_probe_disburse(p_loan uuid, p_amount numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_ctx text;
  v_user uuid := '7dbc67b4-08f6-4da5-8311-9e459d8d9446';
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user::text, 'role','authenticated')::text, true);
  PERFORM mf_disburse_loan(p_loan, CURRENT_DATE, p_amount, 'cash', 'PROBE-1',
    '1df3fdf1-bd50-4f35-a38f-cfb9d377172d', 'Probe', 'probe');
  RETURN jsonb_build_object('ok', true);
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_ctx = PG_EXCEPTION_CONTEXT;
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM, 'sqlstate', SQLSTATE, 'context', v_ctx);
END;
$function$;