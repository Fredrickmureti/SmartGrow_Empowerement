
-- Add version column for optimistic concurrency control on restaurant table orders
ALTER TABLE public.pos_transactions ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;

-- Add index for quickly finding open orders by table session
CREATE INDEX IF NOT EXISTS idx_pos_transactions_table_session_pending 
ON public.pos_transactions(table_session_id) 
WHERE status = 'pending' AND table_session_id IS NOT NULL;

-- Function to generate a draft transaction number for restaurant orders
CREATE OR REPLACE FUNCTION public.get_next_draft_transaction_number(
  p_organization_id UUID,
  p_register_code TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_date_part TEXT;
  v_seq INTEGER;
  v_number TEXT;
BEGIN
  v_date_part := to_char(now(), 'YYMMDD');
  
  SELECT COALESCE(MAX(
    CASE WHEN transaction_number ~ ('^DRF' || p_register_code || '-' || v_date_part || '-[0-9]+$')
    THEN CAST(split_part(transaction_number, '-', 3) AS INTEGER)
    ELSE 0 END
  ), 0) + 1 INTO v_seq
  FROM pos_transactions
  WHERE organization_id = p_organization_id
    AND transaction_number LIKE 'DRF' || p_register_code || '-' || v_date_part || '-%';
  
  v_number := 'DRF' || p_register_code || '-' || v_date_part || '-' || lpad(v_seq::TEXT, 4, '0');
  RETURN v_number;
END;
$$;
