-- Create platform subscription plans table for SaaS owner to configure pricing
CREATE TABLE public.platform_subscription_plans (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    price_monthly NUMERIC(10,2) NOT NULL DEFAULT 0,
    price_yearly NUMERIC(10,2),
    currency TEXT NOT NULL DEFAULT 'USD',
    features JSONB DEFAULT '[]'::jsonb,
    max_users INTEGER,
    max_invoices_per_month INTEGER,
    max_organizations INTEGER DEFAULT 1,
    is_popular BOOLEAN DEFAULT false,
    is_active BOOLEAN DEFAULT true,
    sort_order INTEGER DEFAULT 0,
    stripe_price_id_monthly TEXT,
    stripe_price_id_yearly TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create trigger for updated_at
CREATE TRIGGER update_platform_subscription_plans_updated_at
    BEFORE UPDATE ON public.platform_subscription_plans
    FOR EACH ROW
    EXECUTE FUNCTION public.update_updated_at_column();

-- Enable RLS
ALTER TABLE public.platform_subscription_plans ENABLE ROW LEVEL SECURITY;

-- Everyone can view active plans (for landing page)
CREATE POLICY "Anyone can view active subscription plans"
    ON public.platform_subscription_plans
    FOR SELECT
    USING (is_active = true);

-- Only platform admins can manage plans
CREATE POLICY "Platform admins can manage subscription plans"
    ON public.platform_subscription_plans
    FOR ALL
    USING (public.is_platform_admin(auth.uid()))
    WITH CHECK (public.is_platform_admin(auth.uid()));

-- Insert default plans
INSERT INTO public.platform_subscription_plans (name, description, price_monthly, price_yearly, features, max_users, max_invoices_per_month, is_popular, sort_order) VALUES
    ('Free', 'Perfect for getting started', 0, 0, 
     '["Up to 5 invoices/month", "1 user", "Basic reports", "Email support"]'::jsonb,
     1, 5, false, 1),
    ('Starter', 'Great for small businesses', 19, 190, 
     '["Up to 50 invoices/month", "3 users", "Advanced reports", "Priority email support", "Expense tracking", "Multi-currency"]'::jsonb,
     3, 50, false, 2),
    ('Professional', 'For growing businesses', 49, 490, 
     '["Unlimited invoices", "10 users", "All reports", "Priority support", "Recurring invoices", "API access", "Custom branding"]'::jsonb,
     10, null, true, 3),
    ('Enterprise', 'For large organizations', 99, 990, 
     '["Everything in Professional", "Unlimited users", "Dedicated support", "Custom integrations", "SLA guarantee", "Audit logs", "SSO/SAML"]'::jsonb,
     null, null, false, 4);