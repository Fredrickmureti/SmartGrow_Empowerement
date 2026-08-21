-- Reconciliation Phase 4 — one rule table.
-- `transaction_categorization_rules` was a parallel store the matching engine
-- never read: a rule written there silently did nothing. Ingestion's
-- categorization hint now derives from `bank_reconciliation_rules`, the table
-- `apply_reconciliation_rules` honours, so a rule means the same thing at
-- import time and at match time.
CREATE OR REPLACE FUNCTION public.bank_transaction_apply_rules(
  _organization_id uuid,
  _business_id uuid,
  _bank_account_id uuid,
  _description text,
  _reference text,
  _amount numeric,
  _transaction_type text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $function$
DECLARE
  r       record;
  abs_amt numeric := abs(COALESCE(_amount, 0));
BEGIN
  SELECT br.*, a.name AS account_name
    INTO r
  FROM public.bank_reconciliation_rules br
  JOIN public.accounts a ON a.id = br.counterpart_account_id
  WHERE br.business_id = _business_id
    AND br.is_active
    AND (br.bank_account_id IS NULL OR br.bank_account_id = _bank_account_id)
    AND (br.amount_min IS NULL OR abs_amt >= br.amount_min)
    AND (br.amount_max IS NULL OR abs_amt <= br.amount_max)
    AND (
      br.amount_sign = 'any'
      OR (br.amount_sign = 'debit'  AND _transaction_type = 'debit')
      OR (br.amount_sign = 'credit' AND _transaction_type = 'credit')
    )
    AND (br.description_pattern IS NULL OR COALESCE(_description, '') ILIKE br.description_pattern)
    AND (br.description_regex IS NULL OR COALESCE(_description, '') ~* br.description_regex)
    AND (br.reference_pattern IS NULL OR COALESCE(_reference, '') ILIKE br.reference_pattern)
  ORDER BY br.priority ASC, br.created_at ASC
  LIMIT 1;

  IF r.id IS NULL THEN
    RETURN NULL;
  END IF;

  -- A hint only. The line is still unreconciled and must go through the
  -- match seam before it touches the ledger.
  RETURN jsonb_build_object(
    'category', r.account_name,
    'confidence', 1.0,
    'rule_id', r.id,
    'rule_name', r.name
  );
END;
$function$;

DROP FUNCTION IF EXISTS public.transaction_categorization_rule_upsert(uuid, jsonb, uuid);
DROP FUNCTION IF EXISTS public.transaction_categorization_rule_delete(uuid);
DROP TABLE IF EXISTS public.transaction_categorization_rules;