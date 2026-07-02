
-- Step 1: Remove apps from Free plan that should require Professional or Enterprise
DELETE FROM public.plan_app_access 
WHERE plan_id = '72cbf130-6de2-4f6d-9cbb-b736ff8452d8' 
AND app_id IN ('inventory', 'pos', 'crm', 'projects', 'documents', 'sign', 'spreadsheets', 'hr', 'studio', 'sms');

-- Step 2: Remove apps from Professional plan that should require Enterprise
DELETE FROM public.plan_app_access 
WHERE plan_id = '3e4fbab0-3652-43c7-85db-f2dbe0d66884' 
AND app_id IN ('hr', 'studio', 'sms');

-- Step 3: Create or replace function to track subscription usage on invoice creation
CREATE OR REPLACE FUNCTION public.track_invoice_usage()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_period TEXT;
BEGIN
  v_period := to_char(CURRENT_DATE, 'YYYY-MM');
  
  INSERT INTO subscription_usage (organization_id, period, invoices_count)
  VALUES (NEW.organization_id, v_period, 1)
  ON CONFLICT (organization_id, period)
  DO UPDATE SET 
    invoices_count = subscription_usage.invoices_count + 1,
    updated_at = now();
    
  RETURN NEW;
END;
$$;

-- Step 4: Create or replace function to track user count usage
CREATE OR REPLACE FUNCTION public.track_user_usage()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_period TEXT;
  v_user_count INTEGER;
BEGIN
  v_period := to_char(CURRENT_DATE, 'YYYY-MM');
  
  SELECT COUNT(DISTINCT user_id) INTO v_user_count
  FROM user_roles
  WHERE organization_id = NEW.organization_id
  AND is_active = true;
  
  INSERT INTO subscription_usage (organization_id, period, users_count)
  VALUES (NEW.organization_id, v_period, v_user_count)
  ON CONFLICT (organization_id, period)
  DO UPDATE SET 
    users_count = v_user_count,
    updated_at = now();
    
  RETURN NEW;
END;
$$;

-- Step 5: Attach usage tracking triggers
CREATE TRIGGER track_invoice_usage_trigger
  AFTER INSERT ON public.invoices
  FOR EACH ROW
  EXECUTE FUNCTION public.track_invoice_usage();

CREATE TRIGGER track_user_usage_trigger
  AFTER INSERT ON public.user_roles
  FOR EACH ROW
  EXECUTE FUNCTION public.track_user_usage();
