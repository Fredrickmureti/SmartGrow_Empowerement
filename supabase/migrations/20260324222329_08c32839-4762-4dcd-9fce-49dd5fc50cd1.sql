-- Phase 5: Add reconciliation session detail columns
ALTER TABLE bank_reconciliation_sessions 
  ADD COLUMN IF NOT EXISTS service_charge_amount numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS service_charge_date date,
  ADD COLUMN IF NOT EXISTS service_charge_account_id uuid REFERENCES accounts(id),
  ADD COLUMN IF NOT EXISTS interest_earned_amount numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS interest_earned_date date,
  ADD COLUMN IF NOT EXISTS interest_earned_account_id uuid REFERENCES accounts(id);

-- Track which session cleared each transaction
ALTER TABLE bank_transactions 
  ADD COLUMN IF NOT EXISTS reconciliation_session_id uuid REFERENCES bank_reconciliation_sessions(id);

CREATE INDEX IF NOT EXISTS idx_bank_txn_recon_session 
  ON bank_transactions(reconciliation_session_id) 
  WHERE reconciliation_session_id IS NOT NULL;