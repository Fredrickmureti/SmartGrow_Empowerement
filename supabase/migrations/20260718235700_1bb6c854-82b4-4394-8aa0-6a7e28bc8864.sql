
-- Wave 3 · Phase 1 corrective — revoke direct write privileges on the
-- POS payment-session aggregate from `authenticated`. Writes must flow
-- exclusively through the five SECURITY DEFINER RPCs so the FSM, branch
-- scoping, apply-log idempotency, and outbox emission cannot be bypassed
-- by a client with a valid JWT. SELECT stays (RLS-scoped) so the UI can
-- observe session state during in-flight payments.

REVOKE INSERT, UPDATE, DELETE ON public.pos_payment_sessions FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.pos_payment_session_tenders FROM authenticated;
REVOKE INSERT, UPDATE, DELETE, SELECT ON public.pos_payment_session_apply_log FROM authenticated;

-- Ensure SELECT remains on the two observable tables (idempotent).
GRANT SELECT ON public.pos_payment_sessions TO authenticated;
GRANT SELECT ON public.pos_payment_session_tenders TO authenticated;

-- service_role retains full access for admin/back-office (idempotent).
GRANT ALL ON public.pos_payment_sessions TO service_role;
GRANT ALL ON public.pos_payment_session_tenders TO service_role;
GRANT ALL ON public.pos_payment_session_apply_log TO service_role;
