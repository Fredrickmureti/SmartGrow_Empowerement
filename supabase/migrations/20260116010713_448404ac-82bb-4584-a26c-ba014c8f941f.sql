-- Add subscription_plan_id to organizations
ALTER TABLE public.organizations 
ADD COLUMN IF NOT EXISTS subscription_plan_id UUID REFERENCES public.platform_subscription_plans(id);

-- Create plan_feature_access table for granular feature control
CREATE TABLE IF NOT EXISTS public.plan_feature_access (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plan_id UUID NOT NULL REFERENCES public.platform_subscription_plans(id) ON DELETE CASCADE,
    feature_key TEXT NOT NULL,
    is_enabled BOOLEAN NOT NULL DEFAULT true,
    limit_value INTEGER,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    UNIQUE(plan_id, feature_key)
);

-- Create subscription_usage table to track monthly usage
CREATE TABLE IF NOT EXISTS public.subscription_usage (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    period_start DATE NOT NULL,
    period_end DATE NOT NULL,
    invoices_count INTEGER DEFAULT 0,
    users_count INTEGER DEFAULT 0,
    pos_transactions_count INTEGER DEFAULT 0,
    storage_used_mb NUMERIC DEFAULT 0,
    api_calls_count INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    UNIQUE(organization_id, period_start)
);

-- Enable RLS
ALTER TABLE public.plan_feature_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_usage ENABLE ROW LEVEL SECURITY;

-- RLS policies for plan_feature_access (read by anyone, write by platform admin)
CREATE POLICY "Anyone can view plan features" 
ON public.plan_feature_access 
FOR SELECT 
USING (true);

CREATE POLICY "Platform admins can manage plan features" 
ON public.plan_feature_access 
FOR ALL 
USING (public.is_platform_admin(auth.uid()));

-- RLS policies for subscription_usage
CREATE POLICY "Org members can view their usage" 
ON public.subscription_usage 
FOR SELECT 
USING (public.is_org_member(auth.uid(), organization_id));

CREATE POLICY "Platform admins can view all usage" 
ON public.subscription_usage 
FOR SELECT 
USING (public.is_platform_admin(auth.uid()));

CREATE POLICY "System can update usage" 
ON public.subscription_usage 
FOR ALL 
USING (public.is_platform_admin(auth.uid()) OR public.is_org_member(auth.uid(), organization_id));

-- Create function to check if organization has feature access
CREATE OR REPLACE FUNCTION public.check_org_feature_access(_org_id uuid, _feature_key text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT COALESCE(
        (
            SELECT pfa.is_enabled
            FROM organizations o
            JOIN plan_feature_access pfa ON pfa.plan_id = o.subscription_plan_id
            WHERE o.id = _org_id
            AND pfa.feature_key = _feature_key
        ),
        false
    )
$$;

-- Create function to get feature limit for organization
CREATE OR REPLACE FUNCTION public.get_org_feature_limit(_org_id uuid, _feature_key text)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT pfa.limit_value
    FROM organizations o
    JOIN plan_feature_access pfa ON pfa.plan_id = o.subscription_plan_id
    WHERE o.id = _org_id
    AND pfa.feature_key = _feature_key
$$;

-- Create function to check if organization subscription is active
CREATE OR REPLACE FUNCTION public.is_subscription_active(_org_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT CASE
        WHEN o.is_suspended = true THEN false
        WHEN o.subscription_status = 'active' THEN true
        WHEN o.subscription_status = 'trialing' AND (o.trial_ends_at IS NULL OR o.trial_ends_at > now()) THEN true
        WHEN o.subscription_ends_at IS NOT NULL AND o.subscription_ends_at > now() THEN true
        ELSE false
    END
    FROM organizations o
    WHERE o.id = _org_id
$$;

-- Seed default feature access for existing plans
-- First, let's define the feature keys we'll use
-- Features: pos, reports_financial, reports_sales, reports_management, reports_tax, reports_stock, 
-- banking, ai_assistant, recurring_invoices, multi_currency, api_access, custom_branding, audit_logs,
-- team_management, estimates, credit_notes, purchase_orders, inventory, budgets, journal_entries

-- Insert default features for all existing plans
INSERT INTO public.plan_feature_access (plan_id, feature_key, is_enabled, limit_value)
SELECT 
    p.id,
    f.feature_key,
    CASE 
        -- Free plan: limited features
        WHEN p.name ILIKE '%free%' THEN 
            f.feature_key IN ('reports_sales', 'estimates', 'team_management')
        -- Starter plan: more features
        WHEN p.name ILIKE '%starter%' OR p.name ILIKE '%basic%' THEN 
            f.feature_key IN ('reports_sales', 'reports_financial', 'estimates', 'credit_notes', 
                              'team_management', 'inventory', 'recurring_invoices')
        -- Professional plan: most features
        WHEN p.name ILIKE '%professional%' OR p.name ILIKE '%pro%' THEN 
            f.feature_key IN ('pos', 'reports_sales', 'reports_financial', 'reports_management', 
                              'reports_tax', 'reports_stock', 'banking', 'estimates', 'credit_notes',
                              'purchase_orders', 'inventory', 'recurring_invoices', 'multi_currency',
                              'team_management', 'budgets', 'journal_entries', 'audit_logs')
        -- Enterprise plan: all features
        WHEN p.name ILIKE '%enterprise%' OR p.name ILIKE '%unlimited%' THEN true
        -- Default: basic features
        ELSE f.feature_key IN ('reports_sales', 'estimates', 'team_management')
    END as is_enabled,
    CASE 
        -- Set limits based on plan and feature
        WHEN f.feature_key = 'max_invoices' THEN
            CASE 
                WHEN p.name ILIKE '%free%' THEN 10
                WHEN p.name ILIKE '%starter%' OR p.name ILIKE '%basic%' THEN 100
                WHEN p.name ILIKE '%professional%' OR p.name ILIKE '%pro%' THEN 1000
                ELSE NULL -- unlimited
            END
        WHEN f.feature_key = 'max_users' THEN
            CASE 
                WHEN p.name ILIKE '%free%' THEN 1
                WHEN p.name ILIKE '%starter%' OR p.name ILIKE '%basic%' THEN 5
                WHEN p.name ILIKE '%professional%' OR p.name ILIKE '%pro%' THEN 25
                ELSE NULL -- unlimited
            END
        ELSE NULL
    END as limit_value
FROM public.platform_subscription_plans p
CROSS JOIN (
    VALUES 
        ('pos'), ('reports_financial'), ('reports_sales'), ('reports_management'), 
        ('reports_tax'), ('reports_stock'), ('banking'), ('ai_assistant'), 
        ('recurring_invoices'), ('multi_currency'), ('api_access'), ('custom_branding'), 
        ('audit_logs'), ('team_management'), ('estimates'), ('credit_notes'), 
        ('purchase_orders'), ('inventory'), ('budgets'), ('journal_entries'),
        ('max_invoices'), ('max_users')
) as f(feature_key)
ON CONFLICT (plan_id, feature_key) DO NOTHING;

-- Create trigger for updated_at
CREATE TRIGGER update_plan_feature_access_updated_at
    BEFORE UPDATE ON public.plan_feature_access
    FOR EACH ROW
    EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_subscription_usage_updated_at
    BEFORE UPDATE ON public.subscription_usage
    FOR EACH ROW
    EXECUTE FUNCTION public.update_updated_at_column();