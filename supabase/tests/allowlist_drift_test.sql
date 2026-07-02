-- Phase 6 — CI guard.
-- Fails loudly if any public SECURITY DEFINER function writes
-- accounts.system_role or accounts.is_system without being on the
-- enforce_system_account_helper allowlist (audit fn enumerates them).

DO $$
DECLARE
  v_count int;
  v_names text;
BEGIN
  SELECT count(*), string_agg(function_name, ', ')
    INTO v_count, v_names
    FROM public.audit_system_account_writer_allowlist();

  IF v_count > 0 THEN
    RAISE EXCEPTION 'allowlist drift: % function(s) outside allowlist: %', v_count, v_names;
  END IF;

  RAISE NOTICE 'allowlist invariant holds (0 drift)';
END;
$$;
