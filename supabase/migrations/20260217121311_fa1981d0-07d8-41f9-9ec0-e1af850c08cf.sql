-- Add sms_enabled column to notification_preferences
ALTER TABLE public.notification_preferences
ADD COLUMN sms_enabled boolean DEFAULT true;

-- Add sms_opt_outs table for compliance
CREATE TABLE public.sms_opt_outs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  phone_number TEXT NOT NULL,
  opted_out_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_sms_opt_outs_org_phone ON public.sms_opt_outs(organization_id, phone_number);

ALTER TABLE public.sms_opt_outs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can manage SMS opt-outs"
ON public.sms_opt_outs
FOR ALL
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = auth.uid()
      AND ur.role IN ('super_admin', 'owner', 'admin')
  )
  AND organization_id IN (
    SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()
  )
);

-- Add daily rate limit tracking to sms_provider_configs
ALTER TABLE public.sms_provider_configs
ADD COLUMN daily_limit INTEGER DEFAULT 500,
ADD COLUMN messages_sent_today INTEGER DEFAULT 0,
ADD COLUMN last_reset_date DATE DEFAULT CURRENT_DATE;