
DO $$ BEGIN
  CREATE TYPE public.pos_reversal_type AS ENUM (
    'cancel_pre_payment','void_post_payment','return_refund'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE public.pos_transactions
  ADD COLUMN IF NOT EXISTS reversal_type public.pos_reversal_type,
  ADD COLUMN IF NOT EXISTS void_reason_id uuid,
  ADD COLUMN IF NOT EXISTS void_note text,
  ADD COLUMN IF NOT EXISTS void_override_id uuid;

UPDATE public.pos_transactions SET reversal_type='void_post_payment'
 WHERE reversal_type IS NULL AND status='voided';
UPDATE public.pos_transactions SET reversal_type='return_refund'
 WHERE reversal_type IS NULL AND transaction_type='return';

CREATE TABLE IF NOT EXISTS public.pos_void_reasons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  label text NOT NULL,
  requires_note boolean NOT NULL DEFAULT false,
  sort_order int NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.pos_void_reasons ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated can read void reasons" ON public.pos_void_reasons;
CREATE POLICY "Authenticated can read void reasons"
  ON public.pos_void_reasons FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "Platform admin manages void reasons" ON public.pos_void_reasons;
CREATE POLICY "Platform admin manages void reasons"
  ON public.pos_void_reasons FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.user_roles ur
     WHERE ur.user_id = auth.uid()
       AND (ur.role)::text = ANY (ARRAY['platform_admin','admin'])
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.user_roles ur
     WHERE ur.user_id = auth.uid()
       AND (ur.role)::text = ANY (ARRAY['platform_admin','admin'])
  ));

INSERT INTO public.pos_void_reasons (code, label, requires_note, sort_order) VALUES
  ('wrong_items','Wrong items rung up',false,10),
  ('customer_changed_mind','Customer changed mind',false,20),
  ('cashier_error','Cashier error',false,30),
  ('system_error','System / hardware error',false,40),
  ('other','Other (note required)',true,90)
ON CONFLICT (code) DO NOTHING;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='pos_transactions_void_reason_fk') THEN
    ALTER TABLE public.pos_transactions
      ADD CONSTRAINT pos_transactions_void_reason_fk
      FOREIGN KEY (void_reason_id) REFERENCES public.pos_void_reasons(id);
  END IF;
END $$;

ALTER TABLE public.pos_security_settings
  ADD COLUMN IF NOT EXISTS void_requires_manager_above_amount numeric NOT NULL DEFAULT 0;

DROP FUNCTION IF EXISTS public.process_pos_void(uuid, uuid, text, uuid);

CREATE OR REPLACE FUNCTION public.process_pos_void(
  p_organization_id uuid,
  p_transaction_id  uuid,
  p_void_reason_id  uuid,
  p_void_note       text DEFAULT NULL,
  p_voided_by       uuid DEFAULT NULL,
  p_override_id     uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_tx              RECORD;
  v_reason          RECORD;
  v_shift_status    text;
  v_warehouse_id    uuid;
  v_item            RECORD;
  v_cash_refund     numeric := 0;
  v_threshold       numeric;
  v_require_pin_all boolean;
  v_needs_override  boolean := false;
  v_override_ok     boolean;
  v_has_return      boolean;
BEGIN
  SELECT * INTO v_tx FROM public.pos_transactions
   WHERE id = p_transaction_id AND organization_id = p_organization_id FOR UPDATE;
  IF v_tx IS NULL THEN
    RETURN jsonb_build_object('success',false,'error','not_found','details','Transaction not found');
  END IF;
  IF v_tx.status = 'voided' THEN
    RETURN jsonb_build_object('success',false,'error','already_voided','details','Already voided');
  END IF;
  IF v_tx.status <> 'completed' THEN
    RETURN jsonb_build_object('success',false,'error','invalid_status',
      'details','Only completed transactions can be voided (status: '||v_tx.status||')');
  END IF;

  SELECT status INTO v_shift_status FROM public.pos_shifts WHERE id = v_tx.shift_id;
  IF v_shift_status IS DISTINCT FROM 'open' THEN
    RETURN jsonb_build_object('success',false,'error','shift_not_open',
      'details','Voids are only allowed within the same open shift. Use a return instead.');
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.pos_transactions
     WHERE original_transaction_id = p_transaction_id
       AND transaction_type = 'return' AND status <> 'voided'
  ) INTO v_has_return;
  IF v_has_return THEN
    RETURN jsonb_build_object('success',false,'error','return_exists',
      'details','A return has already been processed against this transaction; void is no longer allowed.');
  END IF;

  SELECT * INTO v_reason FROM public.pos_void_reasons
   WHERE id = p_void_reason_id AND is_active = true;
  IF v_reason IS NULL THEN
    RETURN jsonb_build_object('success',false,'error','invalid_reason',
      'details','Void reason is required and must be active');
  END IF;
  IF v_reason.requires_note AND COALESCE(btrim(p_void_note),'') = '' THEN
    RETURN jsonb_build_object('success',false,'error','note_required',
      'details','Selected void reason requires a note');
  END IF;

  SELECT
    COALESCE(void_requires_manager_above_amount,0),
    COALESCE(require_manager_pin_for_void,false)
    INTO v_threshold, v_require_pin_all
    FROM public.pos_security_settings
   WHERE organization_id = p_organization_id
     AND (business_id IS NULL OR business_id = v_tx.business_id)
   ORDER BY business_id NULLS LAST LIMIT 1;

  v_needs_override := COALESCE(v_require_pin_all,false)
                   OR (COALESCE(v_threshold,0) > 0 AND v_tx.total >= v_threshold);

  IF v_needs_override THEN
    IF p_override_id IS NULL THEN
      RETURN jsonb_build_object('success',false,'error','override_required',
        'details','Manager approval required for this void');
    END IF;
    SELECT EXISTS (
      SELECT 1 FROM public.pos_manager_overrides
       WHERE id = p_override_id
         AND organization_id = p_organization_id
         AND override_type   = 'void_above_threshold'
         AND (transaction_id IS NULL OR transaction_id = p_transaction_id)
         AND COALESCE(approved_at, now()) > now() - interval '15 minutes'
    ) INTO v_override_ok;
    IF NOT v_override_ok THEN
      RETURN jsonb_build_object('success',false,'error','invalid_override',
        'details','Manager override is missing, expired, or wrong type');
    END IF;
  END IF;

  SELECT s.warehouse_id INTO v_warehouse_id FROM public.pos_shifts s WHERE s.id = v_tx.shift_id;
  IF v_warehouse_id IS NULL THEN
    SELECT id INTO v_warehouse_id FROM public.warehouses
     WHERE organization_id = v_tx.organization_id
       AND business_id     = v_tx.business_id
       AND branch_id       = v_tx.branch_id
       AND is_active       = true
     ORDER BY is_default DESC, created_at ASC LIMIT 1;
  END IF;

  FOR v_item IN
    SELECT ti.product_id, ti.quantity, ti.cost_price, p.track_inventory
      FROM public.pos_transaction_items ti
      LEFT JOIN public.products p ON p.id = ti.product_id
     WHERE ti.transaction_id = p_transaction_id
  LOOP
    IF v_item.product_id IS NOT NULL AND v_item.track_inventory = true THEN
      IF v_warehouse_id IS NULL THEN
        RAISE EXCEPTION 'No active warehouse found for branch % — cannot reverse stock for void', v_tx.branch_id
          USING ERRCODE = 'check_violation';
      END IF;
      INSERT INTO public.stock_movements (
        organization_id, business_id, branch_id, product_id, warehouse_id,
        movement_type, quantity, unit_cost, reference_type, reference_id, notes, created_by, movement_date
      ) VALUES (
        v_tx.organization_id, v_tx.business_id, v_tx.branch_id,
        v_item.product_id, v_warehouse_id,
        'pos_return', v_item.quantity, COALESCE(v_item.cost_price,0),
        'pos_transaction', p_transaction_id,
        'Voided: '||v_tx.transaction_number||' — '||v_reason.code,
        p_voided_by, now()
      );
    END IF;
  END LOOP;

  SELECT COALESCE(SUM(amount),0) INTO v_cash_refund
    FROM public.pos_transaction_payments
   WHERE transaction_id = p_transaction_id
     AND payment_method = 'cash'
     AND COALESCE(status,'completed') <> 'voided';
  IF v_cash_refund > 0 THEN
    UPDATE public.pos_shifts
       SET expected_cash = COALESCE(expected_cash,0) - v_cash_refund, updated_at = now()
     WHERE id = v_tx.shift_id;
  END IF;

  UPDATE public.pos_transactions
     SET status='voided', reversal_type='void_post_payment',
         voided_by=p_voided_by, voided_at=now(),
         void_reason=v_reason.code, void_reason_id=v_reason.id,
         void_note=NULLIF(btrim(COALESCE(p_void_note,'')),''),
         void_override_id=p_override_id, updated_at=now()
   WHERE id = p_transaction_id;

  UPDATE public.pos_transaction_payments SET status='voided' WHERE transaction_id = p_transaction_id;

  IF p_override_id IS NOT NULL THEN
    UPDATE public.pos_manager_overrides
       SET transaction_id = p_transaction_id,
           metadata = COALESCE(metadata,'{}'::jsonb) || jsonb_build_object(
             'void_reason_code', v_reason.code, 'voided_amount', v_tx.total)
     WHERE id = p_override_id;
  END IF;

  RETURN jsonb_build_object(
    'success',true,'transaction_id',p_transaction_id,
    'transaction_number',v_tx.transaction_number,
    'voided_amount',v_tx.total,'reversal_type','void_post_payment'
  );
END;
$fn$;

GRANT EXECUTE ON FUNCTION public.process_pos_void(uuid, uuid, uuid, text, uuid, uuid) TO authenticated;
