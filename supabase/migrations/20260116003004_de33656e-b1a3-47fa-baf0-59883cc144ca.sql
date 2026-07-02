-- Phase 3: Loyalty System Tables

-- Create loyalty programs table
CREATE TABLE public.loyalty_programs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  points_per_currency DECIMAL(10,4) DEFAULT 1.0,
  points_to_currency_ratio DECIMAL(10,4) DEFAULT 0.01,
  minimum_points_redemption DECIMAL(15,2) DEFAULT 100,
  tiers JSONB DEFAULT '[
    {"name": "Bronze", "min_points": 0, "discount_percent": 0},
    {"name": "Silver", "min_points": 1000, "discount_percent": 5},
    {"name": "Gold", "min_points": 5000, "discount_percent": 10},
    {"name": "Platinum", "min_points": 10000, "discount_percent": 15}
  ]'::jsonb,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Create customer loyalty table
CREATE TABLE public.customer_loyalty (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  program_id UUID NOT NULL REFERENCES loyalty_programs(id) ON DELETE CASCADE,
  points_balance DECIMAL(15,2) DEFAULT 0,
  points_earned_total DECIMAL(15,2) DEFAULT 0,
  points_redeemed_total DECIMAL(15,2) DEFAULT 0,
  current_tier TEXT DEFAULT 'Bronze',
  total_spent DECIMAL(15,2) DEFAULT 0,
  visit_count INTEGER DEFAULT 0,
  last_visit TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(contact_id, program_id)
);

-- Create loyalty transactions table
CREATE TABLE public.loyalty_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_loyalty_id UUID NOT NULL REFERENCES customer_loyalty(id) ON DELETE CASCADE,
  pos_transaction_id UUID REFERENCES pos_transactions(id) ON DELETE SET NULL,
  points_change DECIMAL(15,2) NOT NULL,
  transaction_type TEXT NOT NULL CHECK (transaction_type IN ('earned', 'redeemed', 'adjusted', 'expired', 'bonus')),
  description TEXT,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Add indexes
CREATE INDEX idx_loyalty_programs_org ON loyalty_programs(organization_id);
CREATE INDEX idx_customer_loyalty_contact ON customer_loyalty(contact_id);
CREATE INDEX idx_customer_loyalty_program ON customer_loyalty(program_id);
CREATE INDEX idx_loyalty_transactions_customer ON loyalty_transactions(customer_loyalty_id);
CREATE INDEX idx_loyalty_transactions_pos ON loyalty_transactions(pos_transaction_id);

-- Enable RLS
ALTER TABLE public.loyalty_programs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_loyalty ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loyalty_transactions ENABLE ROW LEVEL SECURITY;

-- RLS Policies for loyalty_programs
CREATE POLICY "Users can view loyalty programs in their organizations"
ON public.loyalty_programs FOR SELECT
USING (organization_id IN (SELECT public.get_user_organizations(auth.uid())));

CREATE POLICY "Users can insert loyalty programs in their organizations"
ON public.loyalty_programs FOR INSERT
WITH CHECK (organization_id IN (SELECT public.get_user_organizations(auth.uid())));

CREATE POLICY "Users can update loyalty programs in their organizations"
ON public.loyalty_programs FOR UPDATE
USING (organization_id IN (SELECT public.get_user_organizations(auth.uid())));

CREATE POLICY "Users can delete loyalty programs in their organizations"
ON public.loyalty_programs FOR DELETE
USING (organization_id IN (SELECT public.get_user_organizations(auth.uid())));

-- RLS Policies for customer_loyalty
CREATE POLICY "Users can view customer loyalty in their organizations"
ON public.customer_loyalty FOR SELECT
USING (program_id IN (
  SELECT id FROM loyalty_programs WHERE organization_id IN (SELECT public.get_user_organizations(auth.uid()))
));

CREATE POLICY "Users can insert customer loyalty in their organizations"
ON public.customer_loyalty FOR INSERT
WITH CHECK (program_id IN (
  SELECT id FROM loyalty_programs WHERE organization_id IN (SELECT public.get_user_organizations(auth.uid()))
));

CREATE POLICY "Users can update customer loyalty in their organizations"
ON public.customer_loyalty FOR UPDATE
USING (program_id IN (
  SELECT id FROM loyalty_programs WHERE organization_id IN (SELECT public.get_user_organizations(auth.uid()))
));

-- RLS Policies for loyalty_transactions
CREATE POLICY "Users can view loyalty transactions in their organizations"
ON public.loyalty_transactions FOR SELECT
USING (customer_loyalty_id IN (
  SELECT cl.id FROM customer_loyalty cl
  JOIN loyalty_programs lp ON cl.program_id = lp.id
  WHERE lp.organization_id IN (SELECT public.get_user_organizations(auth.uid()))
));

CREATE POLICY "Users can insert loyalty transactions in their organizations"
ON public.loyalty_transactions FOR INSERT
WITH CHECK (customer_loyalty_id IN (
  SELECT cl.id FROM customer_loyalty cl
  JOIN loyalty_programs lp ON cl.program_id = lp.id
  WHERE lp.organization_id IN (SELECT public.get_user_organizations(auth.uid()))
));

-- Triggers for updated_at
CREATE TRIGGER update_loyalty_programs_updated_at
  BEFORE UPDATE ON loyalty_programs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_customer_loyalty_updated_at
  BEFORE UPDATE ON customer_loyalty
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();