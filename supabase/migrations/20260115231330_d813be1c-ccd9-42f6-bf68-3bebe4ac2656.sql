-- Create payment_provider_configs table for storing provider credentials per organization
CREATE TABLE public.payment_provider_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  provider TEXT NOT NULL, -- 'mpesa', 'stripe', 'flutterwave', 'paystack'
  display_name TEXT,
  
  -- Provider-specific credentials (stored as JSONB for flexibility)
  -- M-Pesa: { consumer_key, consumer_secret_encrypted, business_short_code, passkey_encrypted, till_number, environment }
  -- Stripe: { publishable_key, secret_key_encrypted, webhook_secret_encrypted }
  config JSONB NOT NULL DEFAULT '{}',
  
  -- Status
  is_active BOOLEAN DEFAULT false,
  is_test_mode BOOLEAN DEFAULT true,
  
  -- Callback tracking
  callback_url TEXT,
  last_tested_at TIMESTAMPTZ,
  test_result TEXT, -- 'success', 'failed'
  test_error TEXT,
  
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  
  UNIQUE(organization_id, provider)
);

-- Create payment_requests table for tracking STK pushes and payment intents
CREATE TABLE public.payment_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  pos_transaction_id UUID REFERENCES public.pos_transactions(id) ON DELETE SET NULL,
  
  provider TEXT NOT NULL, -- 'mpesa', 'stripe', 'flutterwave'
  provider_reference TEXT, -- CheckoutRequestID (M-Pesa) or PaymentIntent ID (Stripe)
  merchant_request_id TEXT, -- M-Pesa MerchantRequestID
  
  amount DECIMAL(15,2) NOT NULL,
  currency TEXT DEFAULT 'KES',
  phone_number TEXT, -- For M-Pesa STK push
  
  status TEXT DEFAULT 'pending', -- pending, processing, completed, failed, cancelled, expired
  result_code TEXT,
  result_description TEXT,
  receipt_number TEXT, -- M-Pesa receipt or Stripe charge ID
  
  -- Timestamps
  initiated_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ, -- For timeout handling
  
  -- Additional data
  metadata JSONB DEFAULT '{}',
  callback_payload JSONB, -- Store raw callback data
  
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Create indexes for efficient querying
CREATE INDEX idx_payment_provider_configs_org ON public.payment_provider_configs(organization_id);
CREATE INDEX idx_payment_provider_configs_provider ON public.payment_provider_configs(organization_id, provider);
CREATE INDEX idx_payment_requests_org ON public.payment_requests(organization_id);
CREATE INDEX idx_payment_requests_provider_ref ON public.payment_requests(provider_reference);
CREATE INDEX idx_payment_requests_status ON public.payment_requests(organization_id, status);
CREATE INDEX idx_payment_requests_phone ON public.payment_requests(phone_number, status);

-- Enable RLS
ALTER TABLE public.payment_provider_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_requests ENABLE ROW LEVEL SECURITY;

-- RLS Policies for payment_provider_configs
-- Only org members can view their org's payment configs
CREATE POLICY "Org members can view payment configs"
ON public.payment_provider_configs
FOR SELECT
USING (public.is_org_member(auth.uid(), organization_id));

-- Only owners and admins can insert payment configs
CREATE POLICY "Org admins can insert payment configs"
ON public.payment_provider_configs
FOR INSERT
WITH CHECK (public.has_any_org_role(auth.uid(), organization_id, ARRAY['owner', 'admin']::app_role[]));

-- Only owners and admins can update payment configs
CREATE POLICY "Org admins can update payment configs"
ON public.payment_provider_configs
FOR UPDATE
USING (public.has_any_org_role(auth.uid(), organization_id, ARRAY['owner', 'admin']::app_role[]));

-- Only owners can delete payment configs
CREATE POLICY "Org owners can delete payment configs"
ON public.payment_provider_configs
FOR DELETE
USING (public.has_role(auth.uid(), organization_id, 'owner'));

-- RLS Policies for payment_requests
-- Org members can view payment requests
CREATE POLICY "Org members can view payment requests"
ON public.payment_requests
FOR SELECT
USING (public.is_org_member(auth.uid(), organization_id));

-- Org members can insert payment requests (cashiers need to create STK pushes)
CREATE POLICY "Org members can insert payment requests"
ON public.payment_requests
FOR INSERT
WITH CHECK (public.is_org_member(auth.uid(), organization_id));

-- Org members can update payment requests
CREATE POLICY "Org members can update payment requests"
ON public.payment_requests
FOR UPDATE
USING (public.is_org_member(auth.uid(), organization_id));

-- Create updated_at trigger for payment_provider_configs
CREATE TRIGGER update_payment_provider_configs_updated_at
BEFORE UPDATE ON public.payment_provider_configs
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- Create updated_at trigger for payment_requests
CREATE TRIGGER update_payment_requests_updated_at
BEFORE UPDATE ON public.payment_requests
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();