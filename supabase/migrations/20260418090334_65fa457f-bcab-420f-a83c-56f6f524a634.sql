-- Recreate the linter view with security_invoker so RLS applies to the caller, not the creator.
ALTER VIEW public.v_je_source_consistency SET (security_invoker = true);