CREATE OR REPLACE FUNCTION public.enforce_user_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _org_id uuid;
  _plan_limit int;
  _override_limit int;
  _current_count int;
  _effective_limit int;
BEGIN
  _org_id := NEW.organization_id;

  IF _org_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Get plan limit
  SELECT (pl.limits->>'max_users')::int INTO _plan_limit
  FROM organizations o
  JOIN subscription_plans pl ON pl.id = o.subscription_plan_id
  WHERE o.id = _org_id;

  -- Check for org-level override
  SELECT (oeo.override_value)::int INTO _override_limit
  FROM org_entitlement_overrides oeo
  WHERE oeo.organization_id = _org_id
    AND oeo.key = 'max_users'
    AND oeo.override_type = 'limit'
    AND oeo.is_active = true
    AND (oeo.expires_at IS NULL OR oeo.expires_at > now())
  ORDER BY oeo.created_at DESC
  LIMIT 1;

  _effective_limit := COALESCE(_override_limit, _plan_limit);

  IF _effective_limit IS NULL OR _effective_limit = -1 THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO _current_count
  FROM profiles
  WHERE organization_id = _org_id;

  IF _current_count >= _effective_limit THEN
    RAISE EXCEPTION 'User limit reached (% of %). Upgrade your plan or contact support.', _current_count, _effective_limit;
  END IF;

  RETURN NEW;
END;
$$;