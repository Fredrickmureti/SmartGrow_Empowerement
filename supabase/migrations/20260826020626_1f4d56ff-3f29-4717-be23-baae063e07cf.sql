ALTER FUNCTION public._tg_stamp_invoice_currency() SECURITY INVOKER;
ALTER FUNCTION public._tg_stamp_estimate_currency() SECURITY INVOKER;
ALTER FUNCTION public._tg_stamp_sales_order_currency() SECURITY INVOKER;
ALTER FUNCTION public._tg_stamp_customer_refund_currency() SECURITY INVOKER;

REVOKE EXECUTE ON FUNCTION public._fx_document_is_posted_any(text[], uuid) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public._tg_stamp_bill_payment_currency() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public._tg_stamp_bank_transaction_currency() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public._tg_stamp_rfq_quotation_currency() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public._tg_stamp_bill_payment_currency() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public._tg_stamp_bank_transaction_currency() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public._tg_stamp_rfq_quotation_currency() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public._fx_document_is_posted_any(text[], uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fx_stamped_rate_review(uuid) FROM anon;