
-- Add external gateway tracking columns to organizations
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS external_subscription_id text,
  ADD COLUMN IF NOT EXISTS external_customer_id text;

-- Create webhook events deduplication table
CREATE TABLE IF NOT EXISTS public.webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  event_id text NOT NULL,
  event_type text NOT NULL,
  organization_id uuid REFERENCES public.organizations(id),
  processed_at timestamptz NOT NULL DEFAULT now(),
  payload jsonb,
  UNIQUE(provider, event_id)
);

-- Enable RLS
ALTER TABLE public.webhook_events ENABLE ROW LEVEL SECURITY;

-- Only service role can access webhook events
CREATE POLICY "Service role only" ON public.webhook_events
  FOR ALL USING (false);

-- Index for quick lookups
CREATE INDEX idx_webhook_events_provider_event ON public.webhook_events(provider, event_id);
CREATE INDEX idx_organizations_external_sub ON public.organizations(external_subscription_id) WHERE external_subscription_id IS NOT NULL;
CREATE INDEX idx_organizations_external_cust ON public.organizations(external_customer_id) WHERE external_customer_id IS NOT NULL;
