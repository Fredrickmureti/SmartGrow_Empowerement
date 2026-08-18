-- Phase 13 hardening: anon must never reach the matching seam, and the
-- internal validator is not part of the client surface.
REVOKE EXECUTE ON FUNCTION public.bank_match_propose(uuid, jsonb, numeric, text, uuid, text, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.bank_match_confirm(uuid, uuid, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.bank_match_reject(uuid, text, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.bank_match_reverse(uuid, text, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public._bank_match_validate(public.bank_transactions, jsonb, numeric) FROM anon, authenticated;