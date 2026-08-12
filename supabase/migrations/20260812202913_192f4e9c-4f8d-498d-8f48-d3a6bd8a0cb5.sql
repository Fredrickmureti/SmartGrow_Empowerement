REVOKE ALL ON FUNCTION public.preview_reversal_extras_expense(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.preview_reversal_extras_customer_refund(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.preview_reversal_extras_expense(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.preview_reversal_extras_customer_refund(uuid) TO service_role;
NOTIFY pgrst, 'reload schema';