DROP FUNCTION IF EXISTS public.mf_delete_loan_application(uuid);
REVOKE ALL ON FUNCTION public.mf_delete_loan_application(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mf_delete_loan_application(uuid, text) TO authenticated;