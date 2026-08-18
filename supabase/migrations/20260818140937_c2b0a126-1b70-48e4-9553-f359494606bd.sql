-- Finance Wave 2 · Phase 16 — the feed read model must be readable under RLS.
-- bank_feed_status is SECURITY INVOKER on purpose (RLS applies), so the
-- signed-in role needs table-level SELECT. Writes stay seam-only.
GRANT SELECT ON public.bank_feed_connections TO authenticated;
GRANT SELECT ON public.bank_feed_runs TO authenticated;
GRANT ALL ON public.bank_feed_connections TO service_role;
GRANT ALL ON public.bank_feed_runs TO service_role;
REVOKE INSERT, UPDATE, DELETE ON public.bank_feed_connections FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.bank_feed_runs FROM authenticated;
REVOKE ALL ON public.bank_feed_connections FROM anon;
REVOKE ALL ON public.bank_feed_runs FROM anon;