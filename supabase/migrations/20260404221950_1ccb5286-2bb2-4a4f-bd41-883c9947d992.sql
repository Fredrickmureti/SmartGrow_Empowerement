-- Phase 2: Add per-user pricing columns
ALTER TABLE platform_subscription_plans
  ADD COLUMN IF NOT EXISTS price_per_user_monthly numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS price_per_user_yearly numeric DEFAULT 0;

-- Phase 5: Create subscription-active RLS helper function
CREATE OR REPLACE FUNCTION public.is_org_subscription_active(_org_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM organizations
    WHERE id = _org_id
      AND is_suspended IS NOT TRUE
      AND (
        subscription_status IS NULL  -- backward compat: no subscription configured
        OR subscription_status = 'active'
        OR (subscription_status = 'trial' AND (trial_ends_at IS NULL OR trial_ends_at > now()))
      )
  )
$$;

COMMENT ON FUNCTION public.is_org_subscription_active IS 'SECURITY DEFINER helper for RLS: checks if org has active subscription without recursion';