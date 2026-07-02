
-- 1. Add POS link to C2B transactions
ALTER TABLE public.mpesa_c2b_transactions
  ADD COLUMN IF NOT EXISTS matched_pos_transaction_id uuid
    REFERENCES public.pos_transactions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_mpesa_c2b_unreconciled_lookup
  ON public.mpesa_c2b_transactions (organization_id, business_id, is_reconciled, trans_time DESC)
  WHERE is_reconciled = false;

CREATE INDEX IF NOT EXISTS idx_mpesa_c2b_matched_pos_tx
  ON public.mpesa_c2b_transactions (matched_pos_transaction_id)
  WHERE matched_pos_transaction_id IS NOT NULL;

-- 2. Single-attachment guard
CREATE OR REPLACE FUNCTION public.enforce_c2b_single_attachment()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.matched_invoice_id IS NOT NULL AND NEW.matched_pos_transaction_id IS NOT NULL THEN
    RAISE EXCEPTION 'C2B transaction % cannot be attached to both an invoice and a POS sale', NEW.trans_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.matched_pos_transaction_id IS NOT NULL
       AND NEW.matched_pos_transaction_id IS DISTINCT FROM OLD.matched_pos_transaction_id THEN
      RAISE EXCEPTION 'C2B transaction % is already attached to POS sale %; detach first',
        NEW.trans_id, OLD.matched_pos_transaction_id
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.matched_invoice_id IS NOT NULL
       AND NEW.matched_invoice_id IS DISTINCT FROM OLD.matched_invoice_id
       AND NEW.matched_pos_transaction_id IS NOT NULL THEN
      RAISE EXCEPTION 'C2B transaction % is already attached to invoice %; cannot reassign to POS',
        NEW.trans_id, OLD.matched_invoice_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_c2b_single_attachment ON public.mpesa_c2b_transactions;
CREATE TRIGGER trg_enforce_c2b_single_attachment
  BEFORE INSERT OR UPDATE ON public.mpesa_c2b_transactions
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_c2b_single_attachment();

-- 3. Attach RPC for cashier UI
CREATE OR REPLACE FUNCTION public.attach_c2b_to_pos_transaction(
  _c2b_id uuid,
  _pos_transaction_id uuid
)
RETURNS public.pos_transaction_payments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_c2b           public.mpesa_c2b_transactions%ROWTYPE;
  v_pos           public.pos_transactions%ROWTYPE;
  v_payment       public.pos_transaction_payments%ROWTYPE;
  v_paid_so_far   numeric;
  v_remaining     numeric;
BEGIN
  SELECT * INTO v_c2b FROM public.mpesa_c2b_transactions WHERE id = _c2b_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'M-Pesa transaction not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_c2b.is_reconciled OR v_c2b.matched_pos_transaction_id IS NOT NULL OR v_c2b.matched_invoice_id IS NOT NULL THEN
    RAISE EXCEPTION 'M-Pesa transaction % is already reconciled', v_c2b.trans_id USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_pos FROM public.pos_transactions WHERE id = _pos_transaction_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'POS transaction not found' USING ERRCODE = 'no_data_found';
  END IF;

  IF v_pos.business_id IS NULL OR NOT public.user_has_business_access(v_pos.business_id) THEN
    RAISE EXCEPTION 'Not authorized to attach payments to this POS sale' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_c2b.organization_id IS DISTINCT FROM v_pos.organization_id THEN
    RAISE EXCEPTION 'M-Pesa payment belongs to a different organization' USING ERRCODE = 'check_violation';
  END IF;
  IF v_c2b.business_id IS NOT NULL AND v_c2b.business_id IS DISTINCT FROM v_pos.business_id THEN
    RAISE EXCEPTION 'M-Pesa payment belongs to a different business' USING ERRCODE = 'check_violation';
  END IF;

  SELECT COALESCE(SUM(amount), 0) INTO v_paid_so_far
  FROM public.pos_transaction_payments
  WHERE transaction_id = v_pos.id AND status = 'completed';

  v_remaining := COALESCE(v_pos.total, 0) - v_paid_so_far;
  IF v_remaining <= 0 THEN
    RAISE EXCEPTION 'POS sale already fully paid' USING ERRCODE = 'check_violation';
  END IF;

  IF v_c2b.trans_amount < v_remaining THEN
    RAISE EXCEPTION 'M-Pesa amount % is less than remaining balance %', v_c2b.trans_amount, v_remaining
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public.pos_transaction_payments (
    transaction_id, payment_method, amount, reference, mpesa_receipt_number,
    status, processed_at, branch_id, organization_id, business_id
  )
  VALUES (
    v_pos.id, 'mobile_money', v_remaining, v_c2b.trans_id, v_c2b.trans_id,
    'completed', now(), v_pos.branch_id, v_pos.organization_id, v_pos.business_id
  )
  RETURNING * INTO v_payment;

  UPDATE public.mpesa_c2b_transactions
  SET matched_pos_transaction_id = v_pos.id,
      is_reconciled = true,
      reconciled_at = now(),
      reconciled_by = auth.uid(),
      updated_at = now()
  WHERE id = v_c2b.id;

  RETURN v_payment;
END;
$$;

REVOKE ALL ON FUNCTION public.attach_c2b_to_pos_transaction(uuid, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.attach_c2b_to_pos_transaction(uuid, uuid) TO authenticated;

COMMENT ON FUNCTION public.attach_c2b_to_pos_transaction(uuid, uuid) IS
  'Cashier-driven attach: links an unmatched M-Pesa C2B paybill/till transaction to an open POS sale and records the corresponding pos_transaction_payments row. Enforces business access, organization scoping, single-attachment, and amount-sufficiency. Idempotent: re-running on an already-attached C2B raises check_violation.';
