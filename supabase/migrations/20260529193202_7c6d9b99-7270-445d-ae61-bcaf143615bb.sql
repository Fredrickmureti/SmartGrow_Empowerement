-- Diagnostic: run install_localization_pack_atomic and capture the result/error
DO $$
DECLARE
  v_result jsonb;
  v_sqlstate text;
  v_msg text;
  v_detail text;
  v_hint text;
BEGIN
  BEGIN
    v_result := public.install_localization_pack_atomic(
      'f0d5de27-7ac1-48ba-95f0-46f75ea52b30'::uuid,
      'a1b2c3d4-e5f6-7890-abcd-ef1234567890'::uuid,
      NULL::uuid,
      true
    );
    RAISE NOTICE 'INSTALL_OK: %', v_result::text;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS
      v_sqlstate = RETURNED_SQLSTATE,
      v_msg      = MESSAGE_TEXT,
      v_detail   = PG_EXCEPTION_DETAIL,
      v_hint     = PG_EXCEPTION_HINT;
    RAISE NOTICE 'INSTALL_FAILED sqlstate=% step=% msg=% detail=%', v_sqlstate, v_hint, v_msg, v_detail;
  END;
END $$;