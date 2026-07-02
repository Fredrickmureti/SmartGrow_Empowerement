-- Phase 6: Database Schema Updates for Comprehensive Subscription System

-- Add billing period columns to platform_subscription_plans
ALTER TABLE platform_subscription_plans
ADD COLUMN IF NOT EXISTS billing_period TEXT DEFAULT 'monthly',
ADD COLUMN IF NOT EXISTS billing_period_days INTEGER DEFAULT 30;

-- Create subscription_payments table for tracking manual/cash payments
CREATE TABLE IF NOT EXISTS subscription_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  plan_id UUID REFERENCES platform_subscription_plans(id),
  amount NUMERIC NOT NULL,
  currency TEXT DEFAULT 'USD',
  payment_method TEXT, -- 'cash', 'mpesa', 'stripe', 'bank_transfer', etc.
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  status TEXT DEFAULT 'completed',
  notes TEXT,
  recorded_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS on subscription_payments
ALTER TABLE subscription_payments ENABLE ROW LEVEL SECURITY;

-- Platform admins can view all subscription payments
CREATE POLICY "Platform admins can view all subscription payments"
ON subscription_payments
FOR SELECT
USING (public.is_platform_admin(auth.uid()));

-- Platform admins can insert subscription payments
CREATE POLICY "Platform admins can insert subscription payments"
ON subscription_payments
FOR INSERT
WITH CHECK (public.is_platform_admin(auth.uid()));

-- Platform admins can update subscription payments
CREATE POLICY "Platform admins can update subscription payments"
ON subscription_payments
FOR UPDATE
USING (public.is_platform_admin(auth.uid()));

-- Organization members can view their own subscription payments
CREATE POLICY "Org members can view their subscription payments"
ON subscription_payments
FOR SELECT
USING (public.is_org_member(auth.uid(), organization_id));

-- Add expired status check function for automatic expiry
CREATE OR REPLACE FUNCTION public.check_subscription_expired(_org_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
    SELECT CASE
        -- Suspended organizations are blocked
        WHEN o.is_suspended = true THEN true
        -- Active subscriptions that have ended
        WHEN o.subscription_status = 'active' 
             AND o.subscription_ends_at IS NOT NULL 
             AND o.subscription_ends_at < NOW() THEN true
        -- Trial that has ended
        WHEN o.subscription_status = 'trial' 
             AND o.trial_ends_at IS NOT NULL 
             AND o.trial_ends_at < NOW() THEN true
        -- Already marked as expired or cancelled
        WHEN o.subscription_status IN ('expired', 'cancelled') THEN true
        ELSE false
    END
    FROM organizations o
    WHERE o.id = _org_id
$$;

-- Function to get days remaining in subscription
CREATE OR REPLACE FUNCTION public.get_subscription_days_remaining(_org_id uuid)
RETURNS integer
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
    SELECT CASE
        WHEN o.subscription_status = 'trial' AND o.trial_ends_at IS NOT NULL 
            THEN GREATEST(0, EXTRACT(DAY FROM o.trial_ends_at - NOW())::integer)
        WHEN o.subscription_status = 'active' AND o.subscription_ends_at IS NOT NULL 
            THEN GREATEST(0, EXTRACT(DAY FROM o.subscription_ends_at - NOW())::integer)
        ELSE NULL
    END
    FROM organizations o
    WHERE o.id = _org_id
$$;

-- Create index for faster subscription expiry checks
CREATE INDEX IF NOT EXISTS idx_organizations_subscription_expiry 
ON organizations (subscription_status, subscription_ends_at, trial_ends_at)
WHERE subscription_status IN ('active', 'trial');

-- Update trigger for subscription_payments updated_at
CREATE TRIGGER update_subscription_payments_updated_at
    BEFORE UPDATE ON subscription_payments
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();