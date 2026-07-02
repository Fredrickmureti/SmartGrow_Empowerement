
-- ============================================================
-- Phase A: Foundation — User limit enforcement + inventory alerts guard
-- ============================================================

-- 1. Create a function to get effective user limit for an org
-- (checks org_entitlement_overrides first, then plan)
CREATE OR REPLACE FUNCTION public.get_effective_user_limit(_org_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    -- Check for org-level override first
    (SELECT (override_value->>'value')::integer 
     FROM org_entitlement_overrides 
     WHERE organization_id = _org_id 
       AND override_type = 'limit' 
       AND key = 'max_users' 
       AND is_active = true 
       AND (expires_at IS NULL OR expires_at > now())
     LIMIT 1),
    -- Fall back to plan limit
    (SELECT p.max_users 
     FROM organizations o 
     JOIN platform_subscription_plans p ON o.subscription_plan_id = p.id 
     WHERE o.id = _org_id),
    -- Default: no limit (NULL means unlimited)
    NULL
  );
$$;

-- 2. Create trigger to enforce user count limits on user_roles INSERT
CREATE OR REPLACE FUNCTION public.enforce_user_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _max_users integer;
  _current_count integer;
BEGIN
  -- Get effective limit
  _max_users := get_effective_user_limit(NEW.organization_id);
  
  -- NULL means unlimited
  IF _max_users IS NULL THEN
    RETURN NEW;
  END IF;
  
  -- Count current active users in this org (excluding the one being added)
  SELECT COUNT(DISTINCT user_id) INTO _current_count
  FROM user_roles
  WHERE organization_id = NEW.organization_id;
  
  -- Check if adding this user would exceed the limit
  -- (only count if this is a NEW user, not an additional role for existing user)
  IF NOT EXISTS (
    SELECT 1 FROM user_roles 
    WHERE organization_id = NEW.organization_id 
      AND user_id = NEW.user_id
  ) THEN
    IF _current_count >= _max_users THEN
      RAISE EXCEPTION 'User limit reached. Your plan allows a maximum of % users. Please upgrade your plan or contact support.', _max_users
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  
  RETURN NEW;
END;
$$;

-- Drop if exists, then create trigger
DROP TRIGGER IF EXISTS enforce_user_limit_trigger ON user_roles;
CREATE TRIGGER enforce_user_limit_trigger
  BEFORE INSERT ON user_roles
  FOR EACH ROW
  EXECUTE FUNCTION enforce_user_limit();

-- 3. Create usage counter increment triggers

-- Invoice counter
CREATE OR REPLACE FUNCTION public.increment_invoice_counter()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO org_usage_counters (organization_id, metric_key, current_value, period_start, period_end)
  VALUES (
    NEW.organization_id,
    'invoices_count',
    1,
    date_trunc('month', now()),
    date_trunc('month', now()) + interval '1 month' - interval '1 second'
  )
  ON CONFLICT (organization_id, metric_key, period_start)
  DO UPDATE SET current_value = org_usage_counters.current_value + 1;
  
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS increment_invoice_counter_trigger ON invoices;
CREATE TRIGGER increment_invoice_counter_trigger
  AFTER INSERT ON invoices
  FOR EACH ROW
  EXECUTE FUNCTION increment_invoice_counter();

-- POS transaction counter
CREATE OR REPLACE FUNCTION public.increment_pos_counter()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO org_usage_counters (organization_id, metric_key, current_value, period_start, period_end)
  VALUES (
    NEW.organization_id,
    'pos_transactions_count',
    1,
    date_trunc('month', now()),
    date_trunc('month', now()) + interval '1 month' - interval '1 second'
  )
  ON CONFLICT (organization_id, metric_key, period_start)
  DO UPDATE SET current_value = org_usage_counters.current_value + 1;
  
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS increment_pos_counter_trigger ON pos_transactions;
CREATE TRIGGER increment_pos_counter_trigger
  AFTER INSERT ON pos_transactions
  FOR EACH ROW
  EXECUTE FUNCTION increment_pos_counter();

-- User counter (maintained on user_roles changes)
CREATE OR REPLACE FUNCTION public.refresh_user_counter()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _org_id uuid;
  _count integer;
BEGIN
  _org_id := COALESCE(NEW.organization_id, OLD.organization_id);
  
  SELECT COUNT(DISTINCT user_id) INTO _count
  FROM user_roles
  WHERE organization_id = _org_id;
  
  INSERT INTO org_usage_counters (organization_id, metric_key, current_value, period_start, period_end)
  VALUES (
    _org_id,
    'users_count',
    _count,
    date_trunc('month', now()),
    date_trunc('month', now()) + interval '1 month' - interval '1 second'
  )
  ON CONFLICT (organization_id, metric_key, period_start)
  DO UPDATE SET current_value = _count;
  
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS refresh_user_counter_trigger ON user_roles;
CREATE TRIGGER refresh_user_counter_trigger
  AFTER INSERT OR DELETE ON user_roles
  FOR EACH ROW
  EXECUTE FUNCTION refresh_user_counter();

-- 4. Add unique constraint on org_usage_counters if not exists
-- (needed for ON CONFLICT to work)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'org_usage_counters_org_metric_period_key'
  ) THEN
    ALTER TABLE org_usage_counters 
    ADD CONSTRAINT org_usage_counters_org_metric_period_key 
    UNIQUE (organization_id, metric_key, period_start);
  END IF;
END;
$$;
