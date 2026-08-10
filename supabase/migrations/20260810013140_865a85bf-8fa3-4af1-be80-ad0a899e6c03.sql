GRANT EXECUTE ON FUNCTION public.is_ap_control_account(uuid) TO authenticated, anon, service_role;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'is_ar_control_account'
  ) THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.is_ar_control_account(uuid) TO authenticated, anon, service_role';
  END IF;
END $$;