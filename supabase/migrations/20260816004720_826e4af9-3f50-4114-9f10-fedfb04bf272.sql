-- Phase 7 follow-up: the abandoned-session sweeper is a backend job, not a
-- till operation. Restore the service_role-only exposure the contract test
-- (pos-payment-session-commit-contract) requires.
REVOKE ALL ON FUNCTION public.pos_payment_session_sweep_abandoned(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pos_payment_session_sweep_abandoned(integer) TO service_role;