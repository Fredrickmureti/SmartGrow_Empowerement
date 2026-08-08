REVOKE ALL ON FUNCTION public.resolve_product_account_override(uuid, uuid, uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.resolve_delivery_cogs_lines(uuid, uuid, uuid, boolean, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.resolve_product_account_override(uuid, uuid, uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.resolve_delivery_cogs_lines(uuid, uuid, uuid, boolean, text) TO authenticated, service_role;