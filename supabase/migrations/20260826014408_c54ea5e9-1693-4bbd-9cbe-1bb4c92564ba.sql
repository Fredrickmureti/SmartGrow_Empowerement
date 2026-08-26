-- The audit trail is written only by the SECURITY DEFINER trigger. Default
-- privileges had granted broad access; narrow it to read-only for signed-in
-- users (policy still restricts to finance managers of the company).
REVOKE ALL ON public.exchange_rate_audit FROM anon;
REVOKE ALL ON public.exchange_rate_audit FROM authenticated;
GRANT SELECT ON public.exchange_rate_audit TO authenticated;
GRANT ALL ON public.exchange_rate_audit TO service_role;