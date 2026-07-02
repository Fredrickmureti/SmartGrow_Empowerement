
-- 1. Admin audit log table
CREATE TABLE IF NOT EXISTS public.admin_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  action_type text NOT NULL,
  target_org_id uuid REFERENCES public.organizations(id) ON DELETE SET NULL,
  target_entity_type text,
  target_entity_id text,
  details jsonb DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.admin_audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view audit log"
  ON public.admin_audit_log FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can insert audit log"
  ON public.admin_audit_log FOR INSERT TO authenticated
  WITH CHECK (true);

CREATE INDEX idx_admin_audit_log_org ON public.admin_audit_log(target_org_id);
CREATE INDEX idx_admin_audit_log_created ON public.admin_audit_log(created_at DESC);
CREATE INDEX idx_admin_audit_log_action ON public.admin_audit_log(action_type);

-- 2. Function to get real-time usage counters for an org
CREATE OR REPLACE FUNCTION public.get_org_usage_counters(_org_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _users_count int;
  _invoices_this_month int;
  _employees_count int;
  _month_start date;
BEGIN
  _month_start := date_trunc('month', now())::date;

  SELECT count(*) INTO _users_count
  FROM public.user_roles
  WHERE organization_id = _org_id AND is_active = true;

  SELECT count(*) INTO _invoices_this_month
  FROM public.invoices
  WHERE organization_id = _org_id
    AND created_at >= _month_start;

  SELECT count(*) INTO _employees_count
  FROM public.employees
  WHERE organization_id = _org_id
    AND status = 'active';

  RETURN jsonb_build_object(
    'users_count', _users_count,
    'invoices_this_month', _invoices_this_month,
    'employees_count', _employees_count
  );
END;
$$;

-- 3. Function to check usage limit (with override support)
CREATE OR REPLACE FUNCTION public.check_org_usage_limit(
  _org_id uuid,
  _limit_key text,
  _current_count int DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _plan_limit int;
  _override_limit int;
  _effective_limit int;
  _actual_count int;
  _plan_id uuid;
BEGIN
  -- Get the org's plan
  SELECT subscription_plan_id INTO _plan_id
  FROM public.organizations
  WHERE id = _org_id;

  -- Check for an active override first
  SELECT (override_value->>'value')::int INTO _override_limit
  FROM public.org_entitlement_overrides
  WHERE organization_id = _org_id
    AND override_type = 'limit'
    AND key = _limit_key
    AND is_active = true
    AND (expires_at IS NULL OR expires_at > now())
  LIMIT 1;

  -- Get plan limit
  IF _plan_id IS NOT NULL THEN
    IF _limit_key = 'max_users' THEN
      SELECT max_users INTO _plan_limit FROM public.platform_subscription_plans WHERE id = _plan_id;
    ELSIF _limit_key = 'max_invoices_per_month' THEN
      SELECT max_invoices_per_month INTO _plan_limit FROM public.platform_subscription_plans WHERE id = _plan_id;
    ELSIF _limit_key = 'max_organizations' THEN
      SELECT max_organizations INTO _plan_limit FROM public.platform_subscription_plans WHERE id = _plan_id;
    END IF;
  END IF;

  -- Effective limit: override wins, then plan limit, null = unlimited
  _effective_limit := COALESCE(_override_limit, _plan_limit);

  -- Get actual count if not provided
  IF _current_count IS NOT NULL THEN
    _actual_count := _current_count;
  ELSE
    IF _limit_key = 'max_users' THEN
      SELECT count(*) INTO _actual_count FROM public.user_roles WHERE organization_id = _org_id AND is_active = true;
    ELSIF _limit_key = 'max_invoices_per_month' THEN
      SELECT count(*) INTO _actual_count FROM public.invoices WHERE organization_id = _org_id AND created_at >= date_trunc('month', now());
    ELSE
      _actual_count := 0;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'allowed', (_effective_limit IS NULL OR _actual_count < _effective_limit),
    'limit', _effective_limit,
    'current', _actual_count,
    'remaining', CASE WHEN _effective_limit IS NULL THEN NULL ELSE GREATEST(0, _effective_limit - _actual_count) END
  );
END;
$$;

-- 4. Trigger to enforce user limit on user_roles INSERT
CREATE OR REPLACE FUNCTION public.check_user_limit_before_invite()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _result jsonb;
BEGIN
  _result := public.check_org_usage_limit(NEW.organization_id, 'max_users');
  
  IF NOT (_result->>'allowed')::boolean THEN
    RAISE EXCEPTION 'User limit reached. Your plan allows % users (currently at %). Please upgrade your plan or contact support.',
      _result->>'limit', _result->>'current';
  END IF;
  
  RETURN NEW;
END;
$$;

-- Only create trigger if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_check_user_limit_before_invite'
  ) THEN
    CREATE TRIGGER trg_check_user_limit_before_invite
      BEFORE INSERT ON public.user_roles
      FOR EACH ROW
      EXECUTE FUNCTION public.check_user_limit_before_invite();
  END IF;
END;
$$;
