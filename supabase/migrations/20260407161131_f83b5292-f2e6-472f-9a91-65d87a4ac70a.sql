
CREATE INDEX IF NOT EXISTS idx_pos_transactions_shift_gl 
  ON pos_transactions (shift_id, status, transaction_type, synced_to_accounting);

CREATE INDEX IF NOT EXISTS idx_pos_transactions_org_date 
  ON pos_transactions (organization_id, business_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_pos_transaction_items_txn 
  ON pos_transaction_items (transaction_id);

CREATE INDEX IF NOT EXISTS idx_pos_shifts_org_status_date 
  ON pos_shifts (organization_id, status, opened_at DESC);

CREATE INDEX IF NOT EXISTS idx_pos_shifts_register_status 
  ON pos_shifts (register_id, status);

CREATE TABLE IF NOT EXISTS pos_daily_sales_summary (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  business_id UUID REFERENCES businesses(id) ON DELETE SET NULL,
  branch_id UUID REFERENCES branches(id) ON DELETE SET NULL,
  summary_date DATE NOT NULL,
  total_transactions INTEGER NOT NULL DEFAULT 0,
  total_returns INTEGER NOT NULL DEFAULT 0,
  gross_sales NUMERIC(15,2) NOT NULL DEFAULT 0,
  net_sales NUMERIC(15,2) NOT NULL DEFAULT 0,
  total_tax NUMERIC(15,2) NOT NULL DEFAULT 0,
  total_discounts NUMERIC(15,2) NOT NULL DEFAULT 0,
  total_cost NUMERIC(15,2) NOT NULL DEFAULT 0,
  gross_profit NUMERIC(15,2) NOT NULL DEFAULT 0,
  cash_payments NUMERIC(15,2) NOT NULL DEFAULT 0,
  card_payments NUMERIC(15,2) NOT NULL DEFAULT 0,
  mobile_payments NUMERIC(15,2) NOT NULL DEFAULT 0,
  other_payments NUMERIC(15,2) NOT NULL DEFAULT 0,
  top_products JSONB DEFAULT '[]',
  hourly_breakdown JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(organization_id, business_id, branch_id, summary_date)
);

ALTER TABLE pos_daily_sales_summary ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their org daily summaries"
  ON pos_daily_sales_summary FOR SELECT
  TO authenticated
  USING (organization_id IN (
    SELECT organization_id FROM user_roles WHERE user_id = auth.uid() AND is_active = true
  ));

ALTER TABLE pos_shifts ADD CONSTRAINT chk_closed_shift_immutable 
  CHECK (NOT (status = 'closed' AND closed_at IS NULL));
