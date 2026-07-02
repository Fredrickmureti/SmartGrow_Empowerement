-- Fix get_bank_transactions_paginated: branch scope must derive from
-- bank_accounts.branch_id, not from a non-existent bank_transactions.branch_id
-- column. Bank-feed transactions inherit branch from the parent bank_account
-- per docs/architecture/FINANCE_SCOPE_MODEL.md.

-- 1. Drop both pre-existing overloads so only one canonical signature remains
DROP FUNCTION IF EXISTS public.get_bank_transactions_paginated(
  uuid, uuid, uuid, boolean, text, text, date, date, integer, integer
);
DROP FUNCTION IF EXISTS public.get_bank_transactions_paginated(
  uuid, uuid, uuid, boolean, text, text, date, date, integer, integer, uuid
);

-- 2. Recreate the single canonical overload with branch filter joined via bank_accounts
CREATE OR REPLACE FUNCTION public.get_bank_transactions_paginated(
  _org_id uuid,
  _business_id uuid DEFAULT NULL,
  _bank_account_id uuid DEFAULT NULL,
  _is_reconciled boolean DEFAULT NULL,
  _transaction_type text DEFAULT NULL,
  _search_query text DEFAULT NULL,
  _start_date date DEFAULT NULL,
  _end_date date DEFAULT NULL,
  _page_size integer DEFAULT 100,
  _page_offset integer DEFAULT 0,
  _branch_id uuid DEFAULT NULL
)
RETURNS TABLE (
  id uuid, organization_id uuid, bank_account_id uuid, external_transaction_id text,
  transaction_date date, posting_date date, description text, reference text,
  amount numeric, balance_after numeric, transaction_type text, category text,
  category_confidence numeric, is_reconciled boolean, reconciled_type text,
  reconciled_entity_id uuid, reconciled_at timestamp with time zone, reconciled_by uuid,
  reconciled_payment_id uuid, journal_entry_id uuid,
  ai_suggested_category text, ai_confidence numeric, ai_reasoning text,
  raw_data jsonb, created_at timestamp with time zone, updated_at timestamp with time zone,
  bank_account_name text, bank_name text, total_count bigint
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _total bigint;
BEGIN
  SELECT count(*) INTO _total
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
    AND (_branch_id IS NULL OR ba.branch_id = _branch_id OR ba.branch_id IS NULL);

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
    AND (_branch_id IS NULL OR ba.branch_id = _branch_id OR ba.branch_id IS NULL)
  ORDER BY bt.transaction_date DESC, bt.created_at DESC
  LIMIT _page_size OFFSET _page_offset;
END;
$function$;