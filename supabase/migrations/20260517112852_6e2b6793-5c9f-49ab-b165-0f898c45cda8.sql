-- ============================================================
-- Round 4 — DN↔Invoice atomicity hardening
-- ============================================================

-- 1. Cancellation tracking on delivery_notes (additive).
ALTER TABLE public.delivery_notes
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_by uuid REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS cancellation_reason text;

-- 2. Backfill: legacy DNs created before the round-3 feature should NOT
--    auto-spawn invoices when re-confirmed. The feature shipped at the
--    timestamp embedded in migration 20260517110944.
UPDATE public.delivery_notes
   SET auto_invoice_on_complete = false
 WHERE created_at < '2026-05-17 11:09:44+00'
   AND status NOT IN ('delivered','partial','cancelled')
   AND auto_invoice_on_complete = true;

-- 3. CHECK constraints banning internal automation tokens from
--    user-facing notes. This makes the round-2 backfill permanent.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'delivery_notes_notes_no_system_tokens'
  ) THEN
    ALTER TABLE public.delivery_notes
      ADD CONSTRAINT delivery_notes_notes_no_system_tokens
      CHECK (notes IS NULL OR notes !~ '\[auto-from-invoice:[0-9a-fA-F-]{36}\]');
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='goods_receipts' AND column_name='notes'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='goods_receipts_notes_no_system_tokens'
  ) THEN
    ALTER TABLE public.goods_receipts
      ADD CONSTRAINT goods_receipts_notes_no_system_tokens
      CHECK (notes IS NULL OR notes !~ '\[auto-from-invoice:[0-9a-fA-F-]{36}\]');
  END IF;
END $$;

-- 4. Drop the legacy 4-arg complete_delivery_atomic overload that
--    silently skipped invoice creation. All callers in source already
--    pass p_received_by_user_id.
DROP FUNCTION IF EXISTS public.complete_delivery_atomic(uuid, uuid, text, jsonb);

-- 5. cancel_delivery_atomic — symmetric to complete_delivery_atomic.
--    Reverses stock movements, voids COGS JE, voids draft spawned
--    invoice. Posted spawned invoices block the cancel.
CREATE OR REPLACE FUNCTION public.cancel_delivery_atomic(
  p_dn_id uuid,
  p_user_id uuid,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_dn record;
  v_mov record;
  v_compensating_count int := 0;
  v_je record;
  v_voided_je_ids uuid[] := ARRAY[]::uuid[];
  v_inv record;
  v_inv_status_after text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'auth required' USING ERRCODE='42501';
  END IF;

  SELECT id, organization_id, business_id, branch_id, delivery_number,
         status, spawned_invoice_id, source_invoice_id
    INTO v_dn
    FROM public.delivery_notes
   WHERE id = p_dn_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Delivery note % not found', p_dn_id USING ERRCODE='P0002';
  END IF;

  IF NOT public.user_can_access_business(p_user_id, v_dn.business_id) THEN
    RAISE EXCEPTION 'Access denied for business %', v_dn.business_id USING ERRCODE='42501';
  END IF;

  IF v_dn.status = 'cancelled' THEN
    RETURN jsonb_build_object('success', true, 'already_cancelled', true);
  END IF;

  -- 5a. If a spawned invoice exists, only allow cancel when it is still
  --     draft. Anything posted/paid forces the user through proper
  --     accounting reversal first.
  IF v_dn.spawned_invoice_id IS NOT NULL THEN
    SELECT id, invoice_number, status INTO v_inv
      FROM public.invoices WHERE id = v_dn.spawned_invoice_id FOR UPDATE;
    IF v_inv.status NOT IN ('draft','cancelled') THEN
      RAISE EXCEPTION 'Linked invoice % is %, not draft — reverse the invoice first',
        v_inv.invoice_number, v_inv.status
        USING ERRCODE='P0001';
    END IF;
    IF v_inv.status = 'draft' THEN
      UPDATE public.invoices
         SET status = 'cancelled', updated_at = now()
       WHERE id = v_inv.id;
      v_inv_status_after := 'cancelled';
    ELSE
      v_inv_status_after := v_inv.status;
    END IF;
  END IF;

  -- 5b. Reverse stock movements + warehouse_stock for this DN.
  IF v_dn.status IN ('delivered','partial') THEN
    FOR v_mov IN
      SELECT id, organization_id, business_id, branch_id, warehouse_id,
             product_id, quantity, unit_cost
        FROM public.stock_movements
       WHERE reference_type = 'delivery_note' AND reference_id = p_dn_id
         AND movement_type = 'delivery'
    LOOP
      INSERT INTO public.stock_movements (
        organization_id, business_id, branch_id, warehouse_id,
        product_id, movement_type, quantity, unit_cost,
        reference_type, reference_id, notes, created_by
      ) VALUES (
        v_mov.organization_id, v_mov.business_id, v_mov.branch_id, v_mov.warehouse_id,
        v_mov.product_id, 'delivery_cancel', -v_mov.quantity, v_mov.unit_cost,
        'delivery_note', p_dn_id,
        'Cancellation of delivery ' || v_dn.delivery_number,
        p_user_id
      );
      v_compensating_count := v_compensating_count + 1;
    END LOOP;

    -- 5c. Void COGS journal entries linked to this DN (still in current period).
    FOR v_je IN
      SELECT id FROM public.journal_entries
       WHERE source_type = 'delivery_note' AND source_id = p_dn_id
         AND status = 'posted'
    LOOP
      PERFORM public.void_journal_entry_atomic(
        _entry_id := v_je.id,
        _reason   := COALESCE('DN cancel: ' || p_reason, 'Delivery cancelled'),
        _user_id  := p_user_id
      );
      v_voided_je_ids := array_append(v_voided_je_ids, v_je.id);
    END LOOP;
  END IF;

  UPDATE public.delivery_notes
     SET status = 'cancelled',
         cancelled_at = now(),
         cancelled_by = p_user_id,
         cancellation_reason = p_reason,
         updated_at = now()
   WHERE id = p_dn_id;

  PERFORM public._log_dn_event(p_dn_id, 'cancelled', p_user_id, NULL,
    jsonb_build_object(
      'reason', p_reason,
      'compensating_movements', v_compensating_count,
      'voided_journal_entries', v_voided_je_ids,
      'spawned_invoice_id', v_dn.spawned_invoice_id,
      'spawned_invoice_status_after', v_inv_status_after
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'delivery_id', p_dn_id,
    'compensating_movements', v_compensating_count,
    'voided_journal_entries', v_voided_je_ids,
    'spawned_invoice_id', v_dn.spawned_invoice_id,
    'spawned_invoice_status_after', v_inv_status_after
  );
END $$;

GRANT EXECUTE ON FUNCTION public.cancel_delivery_atomic(uuid, uuid, text) TO authenticated;
