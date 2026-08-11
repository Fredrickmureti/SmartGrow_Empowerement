-- Purchase returns are server-authoritative: every mutation goes through the
-- SECURITY DEFINER purchase_return_* commands, which enforce the FSM, the
-- returnable-quantity check, optimistic concurrency and the append-only event
-- trail. Direct table DML from the client roles would bypass all of it, and
-- purchase_return_events must be append-only even for the server commands' callers.
REVOKE INSERT, UPDATE, DELETE ON public.purchase_returns FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.purchase_return_items FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.purchase_return_events FROM anon, authenticated;

GRANT ALL ON public.purchase_returns TO service_role;
GRANT ALL ON public.purchase_return_items TO service_role;
GRANT ALL ON public.purchase_return_events TO service_role;