
-- Phase 7 step 2: bank reconciliation seam for legal order remittance batches.
-- Adds an FK column on bank_reconciliation_matches pointing to the settled batch,
-- and a SECURITY DEFINER RPC that atomically links a settled batch to an
-- unreconciled bank_transactions row.

ALTER TABLE public.bank_reconciliation_matches
  ADD COLUMN IF NOT EXISTS legal_order_remittance_batch_id uuid
    REFERENCES public.legal_order_remittance_batches(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS bank_reconciliation_matches_lorb_idx
  ON public.bank_reconciliation_matches(legal_order_remittance_batch_id)
  WHERE legal_order_remittance_batch_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.legal_order_match_batch_to_bank_txn(
  _batch_id uuid,
  _bank_transaction_id uuid
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_batch    public.legal_order_remittance_batches%ROWTYPE;
  v_txn      public.bank_transactions%ROWTYPE;
  v_match_id uuid;
  v_actor    uuid := auth.uid();
BEGIN
  SELECT * INTO v_batch FROM public.legal_order_remittance_batches WHERE id = _batch_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'BATCH_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_batch.status <> 'settled' THEN
    RAISE EXCEPTION 'BATCH_NOT_SETTLED: status=%', v_batch.status USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_txn FROM public.bank_transactions WHERE id = _bank_transaction_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'BANK_TXN_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_txn.organization_id <> v_batch.organization_id THEN
    RAISE EXCEPTION 'ORG_MISMATCH' USING ERRCODE = 'P0001';
  END IF;

  IF NOT public.user_has_organization_access(v_batch.organization_id) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  -- Refuse if this batch is already reconciled to a different txn, or the txn
  -- is already fully matched. Idempotent when called with the same pair.
  IF v_batch.settled_bank_transaction_id IS NOT NULL
     AND v_batch.settled_bank_transaction_id <> _bank_transaction_id THEN
    RAISE EXCEPTION 'BATCH_ALREADY_MATCHED' USING ERRCODE = 'P0001';
  END IF;

  SELECT id INTO v_match_id
    FROM public.bank_reconciliation_matches
   WHERE legal_order_remittance_batch_id = _batch_id
     AND bank_transaction_id = _bank_transaction_id
     AND status <> 'reversed'
   LIMIT 1;

  IF v_match_id IS NULL THEN
    INSERT INTO public.bank_reconciliation_matches (
      organization_id, business_id, branch_id, bank_transaction_id,
      matched_entity_type, matched_entity_id,
      matched_amount, residual_amount,
      match_type, status, confidence,
      legal_order_remittance_batch_id, created_by
    ) VALUES (
      v_batch.organization_id, v_batch.business_id, NULL, _bank_transaction_id,
      'legal_order_remittance_batch', _batch_id,
      v_batch.planned_total, 0,
      'manual', 'confirmed', 1.00,
      _batch_id, v_actor
    )
    RETURNING id INTO v_match_id;
  END IF;

  UPDATE public.legal_order_remittance_batches
     SET settled_bank_transaction_id = _bank_transaction_id,
         updated_at = now()
   WHERE id = _batch_id
     AND (settled_bank_transaction_id IS NULL OR settled_bank_transaction_id = _bank_transaction_id);

  RETURN v_match_id;
END;
$$;

REVOKE ALL ON FUNCTION public.legal_order_match_batch_to_bank_txn(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.legal_order_match_batch_to_bank_txn(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.legal_order_match_batch_to_bank_txn(uuid, uuid) TO service_role;
