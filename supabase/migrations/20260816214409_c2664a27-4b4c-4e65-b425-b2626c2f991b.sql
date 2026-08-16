-- 1. Register the missing governance action. Purchase-return submit routed to
--    'purchase_return.approve', an action key that was never registered, so no
--    return could ever leave draft.
INSERT INTO public.governance_action_registry
  (action_key, module, label, description, subject_mode, subject_table,
   severity_default, requires_approval_always, is_active)
VALUES
  ('purchase_return.approve', 'Purchases', 'Approve purchase return',
   'Approve a goods/value return raised against a supplier.',
   'actor', 'purchase_return', 'standard', false, true)
ON CONFLICT (action_key) DO UPDATE SET is_active = true;

-- 2. Guard: every action key a database function routes through approval_route
--    must exist in the registry. Prevents re-introducing an unroutable workflow.
CREATE OR REPLACE FUNCTION public.assert_approval_action_keys_registered()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_missing text[];
BEGIN
  SELECT array_agg(DISTINCT k)
    INTO v_missing
    FROM (
      SELECT (regexp_matches(p.prosrc, 'approval_route\s*\(\s*''([a-z0-9_.]+)''', 'g'))[1] AS k
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
    ) s
   WHERE NOT EXISTS (
     SELECT 1 FROM public.governance_action_registry g
      WHERE g.action_key = s.k AND g.is_active
   );

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'approval action keys used in SQL but not registered: %',
      array_to_string(v_missing, ', ');
  END IF;
END $$;

SELECT public.assert_approval_action_keys_registered();

-- 3. Continue the simulation from submit.
TRUNCATE public._pret_sim_log;
DO $sim$
DECLARE
  v_uid uuid := 'af903a2e-3ab0-43f5-b2f0-1a4000985084';
  v_pr uuid := '085110d0-1cc7-472e-b16f-fbdf2c450871';
  v_ver int; v_res jsonb; v_log jsonb := '[]'::jsonb;
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_uid::text, 'role', 'authenticated')::text, true);
  BEGIN
    SELECT row_version INTO v_ver FROM public.purchase_returns WHERE id = v_pr;
    v_res := public.purchase_return_submit(v_pr, v_ver);
    v_log := v_log || jsonb_build_array(jsonb_build_object('step','submit','detail',v_res,
      'status',(SELECT status FROM public.purchase_returns WHERE id=v_pr)));

    IF (SELECT status FROM public.purchase_returns WHERE id = v_pr) = 'submitted' THEN
      SELECT row_version INTO v_ver FROM public.purchase_returns WHERE id = v_pr;
      v_res := public.purchase_return_approve(v_pr, v_ver, 'Simulation approval');
      v_log := v_log || jsonb_build_array(jsonb_build_object('step','approve','detail',v_res,
        'status',(SELECT status FROM public.purchase_returns WHERE id=v_pr)));
    END IF;

    IF (SELECT status FROM public.purchase_returns WHERE id = v_pr) = 'approved' THEN
      SELECT row_version INTO v_ver FROM public.purchase_returns WHERE id = v_pr;
      v_res := public.purchase_return_dispatch(v_pr, v_ver, CURRENT_DATE, 'SIM-TRACK-1');
      v_log := v_log || jsonb_build_array(jsonb_build_object('step','dispatch','detail',v_res,
        'status',(SELECT status FROM public.purchase_returns WHERE id=v_pr)));

      SELECT row_version INTO v_ver FROM public.purchase_returns WHERE id = v_pr;
      v_res := public.purchase_return_acknowledge(v_pr, v_ver, 'RMA-SIM-1', NULL);
      v_log := v_log || jsonb_build_array(jsonb_build_object('step','acknowledge','detail',v_res,
        'status',(SELECT status FROM public.purchase_returns WHERE id=v_pr)));

      SELECT row_version INTO v_ver FROM public.purchase_returns WHERE id = v_pr;
      v_res := public.purchase_return_raise_credit(v_pr, v_ver);
      v_log := v_log || jsonb_build_array(jsonb_build_object('step','credit','detail',v_res,
        'status',(SELECT status FROM public.purchase_returns WHERE id=v_pr)));
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_log := v_log || jsonb_build_array(jsonb_build_object('step','error','detail',
      jsonb_build_object('sqlstate', SQLSTATE, 'message', SQLERRM)));
  END;
  INSERT INTO public._pret_sim_log(step, ok, detail) VALUES ('run', true, v_log);
END $sim$;