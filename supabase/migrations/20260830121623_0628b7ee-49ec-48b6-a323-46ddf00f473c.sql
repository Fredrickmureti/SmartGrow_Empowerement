-- Single-institution convergence: entitlement resolution no longer reads
-- platform_subscription_plans / plan_app_access / plan_feature_access /
-- org_entitlement_overrides / app_trial_status. Access = RBAC; the only
-- workspace-level gate left is administrative suspension.

CREATE OR REPLACE FUNCTION public.subscription_active_for_org(p_org uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.organizations
    WHERE id = p_org AND COALESCE(is_suspended, false) = false
  );
$function$;

CREATE OR REPLACE FUNCTION public.rls_check_org_can_write(_org_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT COALESCE(NOT o.is_suspended, true)
  FROM public.organizations o
  WHERE o.id = _org_id
$function$;

CREATE OR REPLACE FUNCTION public.get_subscription_days_remaining(_org_id uuid)
RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$ SELECT NULL::integer $function$;

CREATE OR REPLACE FUNCTION public.check_org_app_access(_org_id uuid, _app_id text)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_suspended boolean;
BEGIN
  IF _org_id IS NULL OR _app_id IS NULL OR _app_id = '' THEN RETURN false; END IF;
  SELECT COALESCE(is_suspended, false) INTO v_suspended
    FROM public.organizations WHERE id = _org_id;
  IF NOT FOUND OR v_suspended THEN RETURN false; END IF;
  RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION public.check_org_feature_access_v2(_org_id uuid, _feature_key text)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_suspended boolean;
BEGIN
  IF _org_id IS NULL OR _feature_key IS NULL OR _feature_key = '' THEN RETURN false; END IF;
  SELECT COALESCE(is_suspended, false) INTO v_suspended
    FROM public.organizations WHERE id = _org_id;
  IF NOT FOUND OR v_suspended THEN RETURN false; END IF;
  RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION public.assert_entitlement(p_org_id uuid, p_app_id text)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  IF p_app_id = 'platform' THEN RETURN true; END IF;
  IF public.check_org_app_access(p_org_id, p_app_id) THEN RETURN true; END IF;
  RAISE EXCEPTION 'WORKSPACE_SUSPENDED: this workspace is suspended.'
    USING ERRCODE = 'P0001', HINT = 'suspended';
END;
$function$;

CREATE OR REPLACE FUNCTION public.app_state_for_org(_org_id uuid, _app_id text)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_suspended boolean;
BEGIN
  IF _org_id IS NULL OR _app_id IS NULL OR _app_id = '' THEN RETURN 'not_installed'; END IF;
  SELECT COALESCE(is_suspended, false) INTO v_suspended
    FROM public.organizations WHERE id = _org_id;
  IF NOT FOUND THEN RETURN 'not_installed'; END IF;
  IF v_suspended THEN RETURN 'suspended'; END IF;
  RETURN 'active';
END;
$function$;

-- Usage limits: unlimited in a single-institution deployment.
CREATE OR REPLACE FUNCTION public.get_effective_user_limit(_org_id uuid)
RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$ SELECT NULL::integer $function$;

CREATE OR REPLACE FUNCTION public.get_effective_invoice_limit(_org_id uuid)
RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$ SELECT NULL::integer $function$;

CREATE OR REPLACE FUNCTION public.get_org_feature_limit(_org_id uuid, _feature_key text)
RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$ SELECT NULL::integer $function$;

-- NOTE: public.check_org_usage_limit is intentionally left untouched here; a
-- database guard rejects re-creating it. It is retired in a later step.