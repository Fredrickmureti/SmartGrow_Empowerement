-- Stage 1: GL posting reliability - add tracking column
ALTER TABLE public.pos_shifts 
ADD COLUMN IF NOT EXISTS gl_posted_at TIMESTAMPTZ DEFAULT NULL;

COMMENT ON COLUMN public.pos_shifts.gl_posted_at IS 'Timestamp when GL posting succeeded. NULL means not yet posted.';

-- Stage 2: Performance indexes for scale
CREATE INDEX IF NOT EXISTS idx_pos_transactions_org_created 
  ON public.pos_transactions(organization_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_pos_transactions_shift_type_synced 
  ON public.pos_transactions(shift_id, transaction_type, synced_to_accounting);

CREATE INDEX IF NOT EXISTS idx_pos_transaction_items_txn 
  ON public.pos_transaction_items(transaction_id);

CREATE INDEX IF NOT EXISTS idx_stock_movements_product_date 
  ON public.stock_movements(product_id, movement_date DESC);