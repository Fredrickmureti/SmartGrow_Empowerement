-- Add subscription tracking fields to organizations table
ALTER TABLE public.organizations 
ADD COLUMN IF NOT EXISTS subscription_status TEXT DEFAULT 'trial' CHECK (subscription_status IN ('trial', 'active', 'past_due', 'cancelled', 'suspended')),
ADD COLUMN IF NOT EXISTS subscription_started_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS subscription_ends_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ DEFAULT (now() + interval '14 days'),
ADD COLUMN IF NOT EXISTS is_suspended BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS suspended_reason TEXT;

-- Create admin sent emails table for tracking
CREATE TABLE IF NOT EXISTS public.admin_sent_emails (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sent_by UUID REFERENCES auth.users(id),
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    recipient_type TEXT NOT NULL CHECK (recipient_type IN ('all', 'selected', 'single')),
    recipient_ids UUID[] DEFAULT '{}',
    recipient_count INTEGER DEFAULT 0,
    status TEXT DEFAULT 'sent',
    error_message TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.admin_sent_emails ENABLE ROW LEVEL SECURITY;

-- Only super_admin can access admin_sent_emails
CREATE POLICY "Super admins can manage sent emails"
ON public.admin_sent_emails
FOR ALL
TO authenticated
USING (
    EXISTS (
        SELECT 1 FROM public.user_roles 
        WHERE user_id = auth.uid() 
        AND role = 'super_admin' 
        AND is_active = true
    )
)
WITH CHECK (
    EXISTS (
        SELECT 1 FROM public.user_roles 
        WHERE user_id = auth.uid() 
        AND role = 'super_admin' 
        AND is_active = true
    )
);

-- Add index for faster lookups
CREATE INDEX IF NOT EXISTS idx_admin_sent_emails_created_at ON public.admin_sent_emails(created_at DESC);