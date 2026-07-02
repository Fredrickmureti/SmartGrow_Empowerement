
-- =====================================================================
-- 1) Guard: prevent removing the last active business from a workspace
-- =====================================================================
CREATE OR REPLACE FUNCTION public.prevent_last_business_removal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  remaining_count integer;
  v_org_id uuid;
BEGIN
  -- Determine the org we are checking against
  IF TG_OP = 'DELETE' THEN
    v_org_id := OLD.organization_id;
  ELSIF TG_OP = 'UPDATE' THEN
    -- Only fire when transitioning from active -> inactive (or archived)
    IF (COALESCE(OLD.is_active, true) = true)
       AND (
         COALESCE(NEW.is_active, true) = false
         OR (NEW.archived_at IS NOT NULL AND OLD.archived_at IS NULL)
       )
    THEN
      v_org_id := OLD.organization_id;
    ELSE
      RETURN NEW;
    END IF;
  END IF;

  -- Count OTHER active, non-archived businesses in this workspace
  SELECT COUNT(*) INTO remaining_count
    FROM public.businesses
   WHERE organization_id = v_org_id
     AND id <> COALESCE(OLD.id, NEW.id)
     AND COALESCE(is_active, true) = true
     AND archived_at IS NULL;

  IF remaining_count = 0 THEN
    RAISE EXCEPTION
      'A workspace must always have at least one active company. Create another company before removing this one.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  ELSE
    RETURN NEW;
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_last_business_delete ON public.businesses;
CREATE TRIGGER trg_prevent_last_business_delete
BEFORE DELETE ON public.businesses
FOR EACH ROW
EXECUTE FUNCTION public.prevent_last_business_removal();

DROP TRIGGER IF EXISTS trg_prevent_last_business_deactivate ON public.businesses;
CREATE TRIGGER trg_prevent_last_business_deactivate
BEFORE UPDATE ON public.businesses
FOR EACH ROW
EXECUTE FUNCTION public.prevent_last_business_removal();

-- =====================================================================
-- 2) org_health diagnostic view
-- =====================================================================
CREATE OR REPLACE VIEW public.org_health AS
SELECT
  o.id                                          AS org_id,
  o.name                                        AS org_name,
  o.slug                                        AS org_slug,
  COUNT(DISTINCT b.id) FILTER (
    WHERE COALESCE(b.is_active, true) = true AND b.archived_at IS NULL
  )                                             AS active_businesses_count,
  COUNT(DISTINCT br.id) FILTER (
    WHERE COALESCE(br.is_active, true) = true
  )                                             AS active_branches_count,
  BOOL_OR(uba.is_primary)                       AS has_primary_business,
  CASE
    WHEN COUNT(DISTINCT b.id) FILTER (
      WHERE COALESCE(b.is_active, true) = true AND b.archived_at IS NULL
    ) = 0 THEN 'headless'
    ELSE 'healthy'
  END                                           AS health_status
FROM public.organizations o
LEFT JOIN public.businesses b
       ON b.organization_id = o.id
LEFT JOIN public.branches br
       ON br.organization_id = o.id
LEFT JOIN public.user_business_access uba
       ON uba.organization_id = o.id
GROUP BY o.id, o.name, o.slug;

-- Restrict to authenticated users; RLS on the underlying tables still applies.
REVOKE ALL ON public.org_health FROM anon, public;
GRANT SELECT ON public.org_health TO authenticated;

-- =====================================================================
-- 3) Update create_organization_with_owner to accept a separate
--    company name (Workspace name vs Company legal name in signup)
-- =====================================================================
CREATE OR REPLACE FUNCTION public.create_organization_with_owner(
  org_name             text,
  org_slug             text,
  org_country          text DEFAULT NULL,
  org_currency         text DEFAULT NULL,
  org_business_type    text DEFAULT NULL,
  org_legal_name       text DEFAULT NULL,
  org_is_multi_business boolean DEFAULT false,
  org_company_name     text DEFAULT NULL
)
RETURNS public.organizations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_org public.organizations;
  default_plan_id UUID;
  trial_days INTEGER;
  new_business_id UUID;
  new_branch_id UUID;
  resolved_currency TEXT;
  resolved_country TEXT;
  resolved_legal_name TEXT;
  resolved_company_name TEXT;
BEGIN
  resolved_country      := COALESCE(NULLIF(org_country, ''), 'US');
  resolved_currency     := COALESCE(NULLIF(org_currency, ''), 'USD');
  resolved_company_name := COALESCE(NULLIF(org_company_name, ''), org_name);
  resolved_legal_name   := COALESCE(NULLIF(org_legal_name, ''), resolved_company_name);

  SELECT id, trial_period_days INTO default_plan_id, trial_days
    FROM public.platform_subscription_plans
   WHERE is_default = true AND is_active = true
   LIMIT 1;

  IF EXISTS (SELECT 1 FROM public.organizations WHERE slug = org_slug) THEN
    RAISE EXCEPTION 'Organization with this slug already exists';
  END IF;

  INSERT INTO public.organizations (
    name, slug, business_type,
    subscription_plan_id, subscription_status, trial_ends_at
  )
  VALUES (
    org_name, org_slug, NULLIF(org_business_type, ''),
    default_plan_id,
    CASE WHEN default_plan_id IS NOT NULL THEN 'trial' ELSE NULL END,
    CASE WHEN default_plan_id IS NOT NULL AND trial_days IS NOT NULL
         THEN NOW() + (trial_days || ' days')::INTERVAL
         ELSE NULL END
  )
  RETURNING * INTO new_org;

  INSERT INTO public.user_roles (organization_id, user_id, role, is_active)
  VALUES (new_org.id, auth.uid(), 'owner', true)
  ON CONFLICT (organization_id, user_id) DO NOTHING;

  IF NOT COALESCE(org_is_multi_business, false) THEN
    INSERT INTO public.businesses (
      organization_id, name, legal_name, country, base_currency, is_active
    )
    VALUES (
      new_org.id, resolved_company_name, resolved_legal_name,
      resolved_country, resolved_currency, true
    )
    RETURNING id INTO new_business_id;

    INSERT INTO public.branches (organization_id, business_id, name, is_headquarters, is_active)
    VALUES (new_org.id, new_business_id, 'Main Branch', true, true)
    RETURNING id INTO new_branch_id;

    INSERT INTO public.user_business_access (user_id, organization_id, business_id, is_primary, can_switch)
    VALUES (auth.uid(), new_org.id, new_business_id, true, true)
    ON CONFLICT (user_id, business_id) DO NOTHING;
  END IF;

  INSERT INTO public.subscription_usage (
    organization_id, period_start, period_end,
    invoices_count, users_count, pos_transactions_count, storage_used_mb, api_calls_count
  )
  VALUES (
    new_org.id,
    date_trunc('month', NOW())::date,
    (date_trunc('month', NOW()) + INTERVAL '1 month' - INTERVAL '1 day')::date,
    0, 1, 0, 0, 0
  );

  PERFORM public.seed_default_permission_groups(new_org.id);

  RETURN new_org;
END;
$$;
