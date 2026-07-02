-- ============================================================
-- 1. Enforce user count limit per organization plan
-- ============================================================
CREATE OR REPLACE FUNCTION public.enforce_user_limit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _org_id uuid;
  _max_users int;
  _override_limit int;
  _current_count int;
BEGIN
  -- Get the organization_id from the user role
  _org_id := NEW.organization_id;

  -- Skip if no org (shouldn't happen but safety)
  IF _org_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Get plan limit
  SELECT psp.max_users INTO _max_users
  FROM organizations o
  JOIN platform_subscription_plans psp ON psp.id = o.subscription_plan_id
  WHERE o.id = _org_id;

  -- Check for org-level override
  SELECT (oeo.override_value)::int INTO _override_limit
  FROM org_entitlement_overrides oeo
  WHERE oeo.organization_id = _org_id
    AND oeo.override_key = 'max_users'
    AND oeo.override_type = 'limit'
    AND oeo.is_active = true
    AND (oeo.expires_at IS NULL OR oeo.expires_at > now())
  ORDER BY oeo.created_at DESC
  LIMIT 1;

  -- Use override if present, otherwise plan limit
  IF _override_limit IS NOT NULL THEN
    _max_users := _override_limit;
  END IF;

  -- NULL means unlimited
  IF _max_users IS NULL THEN
    RETURN NEW;
  END IF;

  -- Count current billable users (exclude portal role)
  SELECT COUNT(DISTINCT ur.user_id) INTO _current_count
  FROM user_roles ur
  WHERE ur.organization_id = _org_id
    AND ur.role NOT IN ('portal');

  -- Check if adding this user would exceed the limit
  -- Only count if this is a new user (not already counted)
  IF NOT EXISTS (
    SELECT 1 FROM user_roles
    WHERE organization_id = _org_id
      AND user_id = NEW.user_id
      AND role NOT IN ('portal')
  ) THEN
    IF _current_count >= _max_users THEN
      RAISE EXCEPTION 'User limit reached. Your plan allows % users. Please upgrade your plan or contact support.', _max_users;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- Drop existing trigger if any
DROP TRIGGER IF EXISTS trg_enforce_user_limit ON public.user_roles;

-- Create trigger
CREATE TRIGGER trg_enforce_user_limit
  BEFORE INSERT ON public.user_roles
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_user_limit();

-- ============================================================
-- 2. Enforce invoice count limit per organization plan
-- ============================================================
CREATE OR REPLACE FUNCTION public.enforce_invoice_limit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _max_invoices int;
  _override_limit int;
  _current_count int;
  _month_start date;
BEGIN
  -- Get plan limit
  SELECT psp.max_invoices_per_month INTO _max_invoices
  FROM organizations o
  JOIN platform_subscription_plans psp ON psp.id = o.subscription_plan_id
  WHERE o.id = NEW.organization_id;

  -- Check for org-level override
  SELECT (oeo.override_value)::int INTO _override_limit
  FROM org_entitlement_overrides oeo
  WHERE oeo.organization_id = NEW.organization_id
    AND oeo.override_key = 'max_invoices_per_month'
    AND oeo.override_type = 'limit'
    AND oeo.is_active = true
    AND (oeo.expires_at IS NULL OR oeo.expires_at > now())
  ORDER BY oeo.created_at DESC
  LIMIT 1;

  -- Use override if present
  IF _override_limit IS NOT NULL THEN
    _max_invoices := _override_limit;
  END IF;

  -- NULL means unlimited
  IF _max_invoices IS NULL THEN
    RETURN NEW;
  END IF;

  -- Count invoices created this month
  _month_start := date_trunc('month', now())::date;
  
  SELECT COUNT(*) INTO _current_count
  FROM invoices
  WHERE organization_id = NEW.organization_id
    AND created_at >= _month_start;

  IF _current_count >= _max_invoices THEN
    RAISE EXCEPTION 'Monthly invoice limit reached. Your plan allows % invoices per month. Please upgrade your plan or contact support.', _max_invoices;
  END IF;

  RETURN NEW;
END;
$$;

-- Drop existing trigger if any
DROP TRIGGER IF EXISTS trg_enforce_invoice_limit ON public.invoices;

-- Create trigger
CREATE TRIGGER trg_enforce_invoice_limit
  BEFORE INSERT ON public.invoices
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_invoice_limit();