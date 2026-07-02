-- Add AI categorization fields to bank_transactions for smart suggestions
ALTER TABLE bank_transactions 
ADD COLUMN IF NOT EXISTS ai_suggested_category TEXT,
ADD COLUMN IF NOT EXISTS ai_confidence DECIMAL(3,2),
ADD COLUMN IF NOT EXISTS ai_reasoning TEXT;

-- Add auto-sync settings to bank_accounts
ALTER TABLE bank_accounts
ADD COLUMN IF NOT EXISTS auto_sync_enabled BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS sync_frequency TEXT DEFAULT 'daily',
ADD COLUMN IF NOT EXISTS last_auto_sync_at TIMESTAMPTZ;

-- Create M-Pesa C2B transactions table for incoming Paybill/Till payments
CREATE TABLE IF NOT EXISTS mpesa_c2b_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  transaction_type TEXT NOT NULL, -- 'paybill' or 'till'
  trans_id TEXT NOT NULL, -- M-Pesa transaction ID
  trans_time TIMESTAMPTZ NOT NULL,
  trans_amount DECIMAL(15,2) NOT NULL,
  business_short_code TEXT NOT NULL,
  bill_ref_number TEXT, -- Account number/reference for Paybill
  org_account_balance DECIMAL(15,2),
  third_party_trans_id TEXT,
  msisdn TEXT, -- Phone number (should be masked for privacy)
  first_name TEXT,
  middle_name TEXT,
  last_name TEXT,
  -- Matching
  matched_invoice_id UUID REFERENCES invoices(id),
  matched_contact_id UUID REFERENCES contacts(id),
  is_reconciled BOOLEAN DEFAULT false,
  reconciled_at TIMESTAMPTZ,
  reconciled_by UUID,
  category TEXT,
  -- Metadata
  raw_payload JSONB,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(trans_id)
);

-- Enable RLS on mpesa_c2b_transactions
ALTER TABLE mpesa_c2b_transactions ENABLE ROW LEVEL SECURITY;

-- RLS policies for mpesa_c2b_transactions
CREATE POLICY "Users can view their org mpesa c2b transactions" 
ON mpesa_c2b_transactions 
FOR SELECT 
USING (is_org_member(auth.uid(), organization_id));

CREATE POLICY "Users can insert mpesa c2b transactions for their org" 
ON mpesa_c2b_transactions 
FOR INSERT 
WITH CHECK (is_org_member(auth.uid(), organization_id));

CREATE POLICY "Users can update their org mpesa c2b transactions" 
ON mpesa_c2b_transactions 
FOR UPDATE 
USING (is_org_member(auth.uid(), organization_id));

-- Create index for efficient queries
CREATE INDEX IF NOT EXISTS idx_mpesa_c2b_org ON mpesa_c2b_transactions(organization_id);
CREATE INDEX IF NOT EXISTS idx_mpesa_c2b_trans_id ON mpesa_c2b_transactions(trans_id);
CREATE INDEX IF NOT EXISTS idx_mpesa_c2b_reconciled ON mpesa_c2b_transactions(organization_id, is_reconciled);

-- Add trigger for updated_at
CREATE TRIGGER update_mpesa_c2b_transactions_updated_at
BEFORE UPDATE ON mpesa_c2b_transactions
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();