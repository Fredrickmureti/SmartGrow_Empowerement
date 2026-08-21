-- Phase D (ADR 0136): no currency literal baked into the schema.
ALTER TABLE public.customer_credit_balances ALTER COLUMN currency DROP DEFAULT;

UPDATE public.customer_credit_balances ccb
   SET currency = upper(b.base_currency)
  FROM public.businesses b
 WHERE b.id = ccb.business_id
   AND b.base_currency IS NOT NULL
   AND upper(ccb.currency) <> upper(b.base_currency);

REVOKE EXECUTE ON FUNCTION public.set_business_active_currency(uuid, text, boolean) FROM anon;