-- The preview is STABLE and read-only; granting it to the read-only inspection
-- role lets CI/console verification exercise the real function instead of a
-- hand-copied duplicate of its body.
GRANT EXECUTE ON FUNCTION public.preview_reversal_consequences(text, uuid) TO supabase_read_only_user;
GRANT EXECUTE ON FUNCTION public.resolve_reversal_intent(text, uuid) TO supabase_read_only_user;