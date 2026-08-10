REVOKE EXECUTE ON FUNCTION public.approve_bill(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.approve_bill_payment(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.approve_payment(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.approve_expense(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.approve_vendor_credit_note(uuid) FROM PUBLIC, anon, authenticated;