DROP FUNCTION IF EXISTS public.check_user_limit(uuid);

CREATE FUNCTION public.check_user_limit(
  _org_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT CASE
      WHEN p.max_users IS NULL THEN true
      ELSE (
        SELECT count(DISTINCT ur.user_id) FROM user_roles ur
        WHERE ur.organization_id = _org_id
      ) < p.max_users
    END
    FROM organizations o
    JOIN platform_subscription_plans p ON p.id = o.subscription_plan_id
    WHERE o.id = _org_id),
    true
  );
$$;