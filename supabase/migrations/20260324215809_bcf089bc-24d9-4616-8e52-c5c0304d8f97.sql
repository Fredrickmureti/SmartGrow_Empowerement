-- A3: Server-side paginated bank transactions RPC
CREATE OR REPLACE FUNCTION public.get_bank_transactions_paginated(
  _org_id uuid,
  _business_id uuid DEFAULT NULL,
  _bank_account_id uuid DEFAULT NULL,
  _is_reconciled boolean DEFAULT NULL,
  _transaction_type text DEFAULT NULL,
  _search_query text DEFAULT NULL,
  _start_date date DEFAULT NULL,
  _end_date date DEFAULT NULL,
  _page_size int DEFAULT 100,
  _page_offset int DEFAULT 0
)
RETURNS TABLE (
  id uuid,
  organization_id uuid,
  bank_account_id uuid,
  external_transaction_id text,
  transaction_date date,
  posting_date date,
  description text,
  reference text,
  amount numeric,
  balance_after numeric,
  transaction_type text,
  category text,
  category_confidence numeric,
  is_reconciled boolean,
  reconciled_type text,
  reconciled_entity_id uuid,
  reconciled_at timestamptz,
  reconciled_by uuid,
  reconciled_payment_id uuid,
  journal_entry_id uuid,
  ai_suggested_category text,
  ai_confidence numeric,
  ai_reasoning text,
  raw_data jsonb,
  created_at timestamptz,
  updated_at timestamptz,
  bank_account_name text,
  bank_name text,
  total_count bigint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _total bigint;
BEGIN
  SELECT count(*) INTO _total
  FROM bank_transactions bt
  WHERE bt.organization_id = _org_id
    AND (_business_id IS NULL OR bt.business_id = _business_id)
    AND (_bank_account_id IS NULL OR bt.bank_account_id = _bank_account_id)
    AND (_is_reconciled IS NULL OR bt.is_reconciled = _is_reconciled)
    AND (_transaction_type IS NULL OR bt.transaction_type = _transaction_type)
    AND (_start_date IS NULL OR bt.transaction_date >= _start_date)
    AND (_end_date IS NULL OR bt.transaction_date <= _end_date)
    AND (_search_query IS NULL OR bt.description ILIKE '%' || _search_query || '%' OR bt.reference ILIKE '%' || _search_query || '%');

  RETURN QUERY
  SELECT
    bt.id, bt.organization_id, bt.bank_account_id, bt.external_transaction_id,
    bt.transaction_date, bt.posting_date, bt.description, bt.reference,
    bt.amount, bt.balance_after, bt.transaction_type, bt.category,
    bt.category_confidence, bt.is_reconciled, bt.reconciled_type,
    bt.reconciled_entity_id, bt.reconciled_at, bt.reconciled_by,
    bt.reconciled_payment_id, bt.journal_entry_id,
    bt.ai_suggested_category, bt.ai_confidence, bt.ai_reasoning,
    bt.raw_data, bt.created_at, bt.updated_at,
    ba.name AS bank_account_name, ba.bank_name,
    _total AS total_count
  FROM bank_transactions bt
  LEFT JOIN bank_accounts ba ON ba.id = bt.bank_account_id
  WHERE bt.organization_id = _org_id
    AND (_business_id IS NULL OR bt.business_id = _business_id)
    AND (_bank_account_id IS NULL OR bt.bank_account_id = _bank_account_id)
    AND (_is_reconciled IS NULL OR bt.is_reconciled = _is_reconciled)
    AND (_transaction_type IS NULL OR bt.transaction_type = _transaction_type)
    AND (_start_date IS NULL OR bt.transaction_date >= _start_date)
    AND (_end_date IS NULL OR bt.transaction_date <= _end_date)
    AND (_search_query IS NULL OR bt.description ILIKE '%' || _search_query || '%' OR bt.reference ILIKE '%' || _search_query || '%')
  ORDER BY bt.transaction_date DESC, bt.created_at DESC
  LIMIT _page_size OFFSET _page_offset;
END;
$$;

-- U1: Transaction lifecycle status (IF NOT EXISTS handles re-run safety)
ALTER TABLE public.bank_transactions ADD COLUMN IF NOT EXISTS lifecycle_status text NOT NULL DEFAULT 'imported';

UPDATE public.bank_transactions SET lifecycle_status = CASE WHEN is_reconciled = true THEN 'reconciled' ELSE 'for_review' END WHERE lifecycle_status = 'imported';

-- U2: Split transactions table
CREATE TABLE IF NOT EXISTS public.bank_transaction_splits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_transaction_id uuid NOT NULL REFERENCES public.bank_transactions(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES public.accounts(id),
  amount numeric NOT NULL,
  description text,
  created_at timestamptz DEFAULT now(),
  created_by uuid
);

ALTER TABLE public.bank_transaction_splits ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'bank_transaction_splits' AND policyname = 'Users can manage splits for their org transactions') THEN
    CREATE POLICY "Users can manage splits for their org transactions"
      ON public.bank_transaction_splits FOR ALL TO authenticated
      USING (EXISTS (
        SELECT 1 FROM public.bank_transactions bt
        JOIN public.user_roles ur ON ur.user_id = auth.uid()
        WHERE bt.id = bank_transaction_splits.bank_transaction_id
      ));
  END IF;
END $$;

-- Performance indexes
CREATE INDEX IF NOT EXISTS idx_bank_transactions_lifecycle_status ON public.bank_transactions(organization_id, lifecycle_status);
CREATE INDEX IF NOT EXISTS idx_bank_transactions_org_date ON public.bank_transactions(organization_id, business_id, transaction_date DESC);