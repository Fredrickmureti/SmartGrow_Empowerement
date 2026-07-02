-- Regression: every account carrying a system_role must have detail_type
-- matching the canonical detail_type registered in system_account_template
-- (i.e. the Phase 2a _resolve_account_detail_type contract).

DO $$
DECLARE
  v_drift int;
BEGIN
  SELECT count(*) INTO v_drift
    FROM public.accounts a
    JOIN public.system_account_template t ON t.role_key = a.system_role
   WHERE a.system_role IS NOT NULL
     AND a.detail_type IS DISTINCT FROM t.detail_type;

  IF v_drift > 0 THEN
    RAISE EXCEPTION 'role/detail_type drift: % accounts diverge from system_account_template', v_drift;
  END IF;

  RAISE NOTICE 'role / detail_type canonical mapping holds (0 drift)';
END;
$$;
