-- Trigger routines are internal machinery, not an API surface.
REVOKE ALL ON FUNCTION public._tg_exchange_rates_immutable()      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._tg_exchange_rates_write_guard()    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._tg_exchange_rates_audit()          FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._tg_exchange_rates_immutable()   TO service_role;
GRANT EXECUTE ON FUNCTION public._tg_exchange_rates_write_guard() TO service_role;
GRANT EXECUTE ON FUNCTION public._tg_exchange_rates_audit()       TO service_role;