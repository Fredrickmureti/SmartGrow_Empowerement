
-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 1: Server-Side Subscription Enforcement
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Reusable function to check if an org has an active subscription
CREATE OR REPLACE FUNCTION public.check_org_subscription_active(p_org_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.organizations
    WHERE id = p_org_id
      AND is_suspended IS NOT TRUE
      AND (
        subscription_status IS NULL  -- backward compat: no subscription configured yet
        OR (subscription_status = 'active' AND (subscription_ends_at IS NULL OR subscription_ends_at > now()))
        OR (subscription_status = 'trial' AND (trial_ends_at IS NULL OR trial_ends_at > now()))
      )
  )
$$;

-- 2. RLS write-block policies on core business tables
-- These prevent INSERT when the org's subscription is not active.

-- Invoices
CREATE POLICY "block_invoice_insert_expired_sub"
ON public.invoices FOR INSERT
TO authenticated
WITH CHECK (public.check_org_subscription_active(organization_id));

-- Journal Entries
CREATE POLICY "block_journal_entry_insert_expired_sub"
ON public.journal_entries FOR INSERT
TO authenticated
WITH CHECK (public.check_org_subscription_active(organization_id));

-- Bills
CREATE POLICY "block_bill_insert_expired_sub"
ON public.bills FOR INSERT
TO authenticated
WITH CHECK (public.check_org_subscription_active(organization_id));

-- Purchase Orders
CREATE POLICY "block_po_insert_expired_sub"
ON public.purchase_orders FOR INSERT
TO authenticated
WITH CHECK (public.check_org_subscription_active(organization_id));

-- Expenses
CREATE POLICY "block_expense_insert_expired_sub"
ON public.expenses FOR INSERT
TO authenticated
WITH CHECK (public.check_org_subscription_active(organization_id));

-- Payroll Runs
CREATE POLICY "block_payroll_insert_expired_sub"
ON public.payroll_runs FOR INSERT
TO authenticated
WITH CHECK (public.check_org_subscription_active(organization_id));

-- Sales Orders
CREATE POLICY "block_sales_order_insert_expired_sub"
ON public.sales_orders FOR INSERT
TO authenticated
WITH CHECK (public.check_org_subscription_active(organization_id));

-- 3. User-count enforcement trigger
-- Prevents adding users beyond the plan's max_users limit.
CREATE OR REPLACE FUNCTION public.enforce_user_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_id uuid;
  v_max_users int;
  v_current_count int;
  v_override_limit int;
BEGIN
  -- Get the organization_id for this user_role
  v_org_id := NEW.organization_id;
  
  IF v_org_id IS NULL THEN
    RETURN NEW; -- No org context, allow
  END IF;

  -- Check for org-level limit override first
  SELECT (override_value)::int INTO v_override_limit
  FROM public.org_entitlement_overrides
  WHERE organization_id = v_org_id
    AND override_type = 'limit'
    AND feature_key = 'max_users'
    AND is_active = true
    AND (expires_at IS NULL OR expires_at > now())
  LIMIT 1;

  IF v_override_limit IS NOT NULL THEN
    v_max_users := v_override_limit;
  ELSE
    -- Get from plan
    SELECT max_users INTO v_max_users
    FROM public.platform_subscription_plans p
    JOIN public.organizations o ON o.subscription_plan_id = p.id
    WHERE o.id = v_org_id;
  END IF;

  -- If no limit set (NULL or 0), allow unlimited
  IF v_max_users IS NULL OR v_max_users <= 0 THEN
    RETURN NEW;
  END IF;

  -- Count current users in this org (excluding the one being inserted if it's an upsert)
  SELECT COUNT(DISTINCT user_id) INTO v_current_count
  FROM public.user_roles
  WHERE organization_id = v_org_id
    AND user_id != NEW.user_id;

  -- +1 for the new user being added
  IF (v_current_count + 1) > v_max_users THEN
    RAISE EXCEPTION 'User limit reached: this organization allows a maximum of % users. Current: %. Please upgrade your plan.', v_max_users, v_current_count
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

-- Attach the trigger
DROP TRIGGER IF EXISTS trg_enforce_user_limit ON public.user_roles;
CREATE TRIGGER trg_enforce_user_limit
  BEFORE INSERT ON public.user_roles
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_user_limit();
