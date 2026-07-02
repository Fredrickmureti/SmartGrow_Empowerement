
-- SMS Provider enum
CREATE TYPE public.sms_provider AS ENUM ('twilio');

-- SMS event type enum
CREATE TYPE public.sms_event_type AS ENUM (
  'invoice_posted',
  'payment_received',
  'invoice_overdue',
  'po_sent'
);

-- SMS delivery status enum
CREATE TYPE public.sms_status AS ENUM (
  'queued',
  'sent',
  'delivered',
  'failed',
  'undelivered'
);

-- SMS recipient type enum
CREATE TYPE public.sms_recipient_type AS ENUM (
  'customer',
  'vendor',
  'custom'
);

-- ============================================================
-- sms_provider_configs: per-org Twilio credentials
-- ============================================================
CREATE TABLE public.sms_provider_configs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id UUID REFERENCES public.businesses(id) ON DELETE SET NULL,
  provider public.sms_provider NOT NULL DEFAULT 'twilio',
  is_enabled BOOLEAN NOT NULL DEFAULT false,
  account_sid TEXT NOT NULL DEFAULT '',
  auth_token TEXT NOT NULL DEFAULT '',
  sender_phone TEXT,
  messaging_service_sid TEXT,
  webhook_url TEXT,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(organization_id, business_id)
);

ALTER TABLE public.sms_provider_configs ENABLE ROW LEVEL SECURITY;

-- Only admins (via user_roles) can manage SMS configs
CREATE POLICY "Admins can manage SMS configs"
  ON public.sms_provider_configs
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
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.role IN ('super_admin', 'owner', 'admin')
    )
    AND organization_id IN (
      SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()
    )
  );

-- ============================================================
-- sms_templates: message templates per event
-- ============================================================
CREATE TABLE public.sms_templates (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  event_type public.sms_event_type NOT NULL,
  name TEXT NOT NULL,
  body_template TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.sms_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can manage SMS templates"
  ON public.sms_templates
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
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.role IN ('super_admin', 'owner', 'admin')
    )
    AND organization_id IN (
      SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()
    )
  );

-- ============================================================
-- sms_event_rules: which events trigger SMS
-- ============================================================
CREATE TABLE public.sms_event_rules (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  event_type public.sms_event_type NOT NULL,
  is_enabled BOOLEAN NOT NULL DEFAULT false,
  template_id UUID REFERENCES public.sms_templates(id) ON DELETE SET NULL,
  recipient_type public.sms_recipient_type NOT NULL DEFAULT 'customer',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(organization_id, event_type)
);

ALTER TABLE public.sms_event_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can manage SMS event rules"
  ON public.sms_event_rules
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
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.role IN ('super_admin', 'owner', 'admin')
    )
    AND organization_id IN (
      SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()
    )
  );

-- ============================================================
-- sms_log: audit log of all SMS sent (never stores credentials)
-- ============================================================
CREATE TABLE public.sms_log (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id UUID REFERENCES public.businesses(id) ON DELETE SET NULL,
  event_type public.sms_event_type,
  recipient_phone TEXT NOT NULL,
  message_body TEXT NOT NULL,
  status public.sms_status NOT NULL DEFAULT 'queued',
  provider_message_id TEXT,
  error_code TEXT,
  error_message TEXT,
  cost NUMERIC(10, 4),
  sent_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.sms_log ENABLE ROW LEVEL SECURITY;

-- Admins can read SMS logs for their org
CREATE POLICY "Admins can view SMS logs"
  ON public.sms_log
  FOR SELECT
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

-- Service role inserts logs (edge functions use service role)
CREATE POLICY "Service role can insert SMS logs"
  ON public.sms_log
  FOR INSERT
  TO service_role
  WITH CHECK (true);

-- Service role can update SMS logs (webhook status updates)
CREATE POLICY "Service role can update SMS logs"
  ON public.sms_log
  FOR UPDATE
  TO service_role
  USING (true);

-- Indexes for performance
CREATE INDEX idx_sms_log_org_created ON public.sms_log(organization_id, created_at DESC);
CREATE INDEX idx_sms_log_provider_msg ON public.sms_log(provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE INDEX idx_sms_provider_configs_org ON public.sms_provider_configs(organization_id);

-- Trigger for updated_at on sms_provider_configs
CREATE TRIGGER update_sms_provider_configs_updated_at
  BEFORE UPDATE ON public.sms_provider_configs
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- Trigger for updated_at on sms_templates
CREATE TRIGGER update_sms_templates_updated_at
  BEFORE UPDATE ON public.sms_templates
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- Masked view for provider configs (never exposes full credentials)
CREATE VIEW public.sms_provider_configs_masked AS
SELECT
  id,
  organization_id,
  business_id,
  provider,
  is_enabled,
  CASE WHEN length(account_sid) > 4 THEN '****' || right(account_sid, 4) ELSE '****' END AS account_sid_masked,
  '********' AS auth_token_masked,
  sender_phone,
  messaging_service_sid,
  webhook_url,
  created_by,
  created_at,
  updated_at
FROM public.sms_provider_configs;
