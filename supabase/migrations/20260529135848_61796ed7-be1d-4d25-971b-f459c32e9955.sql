
-- ============================================================
-- Phase 3 #9 — Replace GUC-based bypass with call-stack allowlist
-- ============================================================
-- The previous guard trusted any SECURITY DEFINER caller that set
-- `app.upsert_system_account.in_progress` / `app.reset_in_progress`.
-- Any SECURITY DEFINER function can set a GUC, so the boundary was
-- advisory at best. We now consult PG_CONTEXT (the live call stack)
-- and only permit the mutation when the immediate or any ancestor
-- frame is one of a small, explicit allowlist of functions.

CREATE OR REPLACE FUNCTION public.enforce_system_account_helper()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_stack text;
  -- Functions allowed to mutate accounts.system_role / is_system.
  -- Keep this list MINIMAL. Adding a name here grants it the right
  -- to bypass the system-account integrity guard.
  v_allowed text[] := ARRAY[
    'upsert_system_account',
    'reset_organization_data',
    '_execute_organization_delete',
    'governance_run_teardown',
    'platform_delete_organization',
    'reset_my_workspace',
    'install_localization_pack_atomic',
    'provision_default_chart_of_accounts',
    'payroll_create_and_map_account'
  ];
  v_name text;
BEGIN
  GET DIAGNOSTICS v_stack = PG_CONTEXT;
  -- PG_CONTEXT lines look like:
  --   PL/pgSQL function public.upsert_system_account(...) line 42 at ...
  -- We match on the bare function name preceded by `function ` or
  -- `function public.` to avoid matching a column or string literal.
  FOREACH v_name IN ARRAY v_allowed LOOP
    IF v_stack ~ ('function (public\.)?' || v_name || '\(') THEN
      RETURN NEW;
    END IF;
  END LOOP;

  IF TG_OP = 'INSERT' THEN
    IF NEW.system_role IS NOT NULL OR COALESCE(NEW.is_system, false) = true THEN
      RAISE EXCEPTION
        'system accounts must be provisioned via public.upsert_system_account() — direct INSERT of system_role=% / is_system=% is not allowed',
        NEW.system_role, NEW.is_system
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF (NEW.system_role IS DISTINCT FROM OLD.system_role)
       OR (COALESCE(NEW.is_system,false) IS DISTINCT FROM COALESCE(OLD.is_system,false)) THEN
      RAISE EXCEPTION
        'system_role / is_system on public.accounts can only be changed via an allowlisted provisioning helper'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.enforce_system_account_helper() IS
  'Defends accounts.system_role/is_system via a call-stack allowlist '
  '(PG_CONTEXT scan). Replaces the prior GUC-based bypass, which any '
  'SECURITY DEFINER caller could trivially set. To grant a new function '
  'the right to mutate system-account columns, add its proname to '
  'v_allowed in this body — do not invent a new GUC.';
