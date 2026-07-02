
-- ============================================================
-- Stage 6.1 — POS cash-control hardening (G1, G2, G3, G4, G5)
-- ============================================================

-- ---------- G2: Manager override scoping & single-use ----------

ALTER TABLE public.pos_manager_overrides
  ADD COLUMN IF NOT EXISTS shift_id        uuid,
  ADD COLUMN IF NOT EXISTS status          text NOT NULL DEFAULT 'approved',
  ADD COLUMN IF NOT EXISTS consumed_at     timestamptz,
  ADD COLUMN IF NOT EXISTS consumed_ref_id uuid,
  ADD COLUMN IF NOT EXISTS consumed_table  text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'pos_manager_overrides_status_chk'
  ) THEN
    ALTER TABLE public.pos_manager_overrides
      ADD CONSTRAINT pos_manager_overrides_status_chk
      CHECK (status IN ('approved','consumed','revoked'));
  END IF;
END$$;

UPDATE public.pos_manager_overrides
   SET status = COALESCE(status, 'approved')
 WHERE status IS NULL;

CREATE INDEX IF NOT EXISTS pos_manager_overrides_shift_idx
  ON public.pos_manager_overrides (shift_id) WHERE shift_id IS NOT NULL;

-- ---------- G3: Tighten cash-movement-types RLS to per-business ----------

DROP POLICY IF EXISTS "pos_cash_movement_types read" ON public.pos_cash_movement_types;

CREATE POLICY "pos_cash_movement_types read"
  ON public.pos_cash_movement_types
  FOR SELECT
  USING (public.user_can_access_business(auth.uid(), business_id));

-- ---------- G4: Rebuild expected-cash view to subtract cash refunds ----------

DROP VIEW IF EXISTS public.v_pos_cash_expected;

CREATE VIEW public.v_pos_cash_expected
WITH (security_invoker = true)
AS
SELECT
  s.id              AS shift_id,
  s.organization_id,
  s.business_id,
  s.branch_id,
  s.register_id,
  COALESCE(s.opening_cash, 0) AS opening_cash,
  COALESCE(cash_sales.amt,   0) AS cash_sales,
  COALESCE(cash_refunds.amt, 0) AS cash_refunds,
  COALESCE(movements.amt,    0) AS movements_net,
  COALESCE(s.opening_cash, 0)
    + COALESCE(cash_sales.amt, 0)
    - COALESCE(cash_refunds.amt, 0)
    + COALESCE(movements.amt, 0)         AS expected_cash_computed,
  s.actual_cash,
  s.status
FROM public.pos_shifts s
LEFT JOIN LATERAL (
  SELECT SUM(p.amount) AS amt
    FROM public.pos_transaction_payments p
    JOIN public.pos_transactions t ON t.id = p.transaction_id
   WHERE t.shift_id = s.id
     AND p.payment_method = 'cash'
     AND p.status IN ('completed','succeeded','captured')
     AND COALESCE(t.transaction_type, 'sale') = 'sale'
     AND COALESCE(t.status, 'completed') NOT IN ('voided','cancelled')
) cash_sales ON true
LEFT JOIN LATERAL (
  SELECT SUM(p.amount) AS amt
    FROM public.pos_transaction_payments p
    JOIN public.pos_transactions t ON t.id = p.transaction_id
   WHERE t.shift_id = s.id
     AND p.payment_method = 'cash'
     AND p.status IN ('completed','succeeded','captured')
     AND (
           COALESCE(t.transaction_type, 'sale') IN ('return','refund')
        OR COALESCE(t.status, 'completed') = 'voided'
     )
) cash_refunds ON true
LEFT JOIN LATERAL (
  SELECT SUM(
    CASE m.movement_type
      WHEN 'opening_float'  THEN  m.amount
      WHEN 'cash_in'        THEN  m.amount
      WHEN 'correction'     THEN  m.amount
      WHEN 'float'          THEN  m.amount
      WHEN 'cash_out'       THEN -m.amount
      WHEN 'pickup'         THEN -m.amount
      WHEN 'drop'           THEN -m.amount
      WHEN 'safe_drop'      THEN -m.amount
      WHEN 'bank_deposit'   THEN -m.amount
      WHEN 'petty_cash_out' THEN -m.amount
      ELSE 0
    END
  ) AS amt
    FROM public.pos_cash_movements m
   WHERE m.shift_id = s.id
) movements ON true;

GRANT SELECT ON public.v_pos_cash_expected TO authenticated;

-- ---------- G1: Seed default GL accounts per business ----------

CREATE OR REPLACE FUNCTION public.seed_pos_cash_movement_type_defaults(p_business_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid;
  v_cash_id  uuid;
  v_petty_id uuid;
  v_bank_id  uuid;
BEGIN
  SELECT organization_id INTO v_org FROM businesses WHERE id = p_business_id;
  IF v_org IS NULL THEN RETURN; END IF;

  SELECT id INTO v_cash_id  FROM accounts
   WHERE business_id = p_business_id AND is_active = true
     AND (code IN ('1110','1010','1015') OR name ILIKE '%cash and cash equivalents%' OR name ILIKE '%cash on hand%')
   ORDER BY code LIMIT 1;

  SELECT id INTO v_petty_id FROM accounts
   WHERE business_id = p_business_id AND is_active = true
     AND (code IN ('1111','1020') OR name ILIKE '%petty cash%')
   ORDER BY code LIMIT 1;

  SELECT id INTO v_bank_id  FROM accounts
   WHERE business_id = p_business_id AND is_active = true
     AND (code IN ('1112','1100','1101') OR name ILIKE 'bank %' OR name ILIKE '%bank - main%' OR name ILIKE '%bank account%')
   ORDER BY code LIMIT 1;

  -- cash_in: Dr Cash, Cr Petty Cash (cash brought into till from petty/safe)
  IF v_cash_id IS NOT NULL AND v_petty_id IS NOT NULL THEN
    UPDATE pos_cash_movement_types SET
      gl_debit_account_id  = v_cash_id,
      gl_credit_account_id = v_petty_id
     WHERE business_id = p_business_id AND movement_type = 'cash_in'
       AND (gl_debit_account_id IS NULL OR gl_credit_account_id IS NULL);

    -- cash_out: Dr Petty Cash, Cr Cash
    UPDATE pos_cash_movement_types SET
      gl_debit_account_id  = v_petty_id,
      gl_credit_account_id = v_cash_id
     WHERE business_id = p_business_id AND movement_type = 'cash_out'
       AND (gl_debit_account_id IS NULL OR gl_credit_account_id IS NULL);

    -- pickup: Dr Petty Cash (safe), Cr Cash (drawer)
    UPDATE pos_cash_movement_types SET
      gl_debit_account_id  = v_petty_id,
      gl_credit_account_id = v_cash_id
     WHERE business_id = p_business_id AND movement_type = 'pickup'
       AND (gl_debit_account_id IS NULL OR gl_credit_account_id IS NULL);

    -- safe_drop: same as pickup
    UPDATE pos_cash_movement_types SET
      gl_debit_account_id  = v_petty_id,
      gl_credit_account_id = v_cash_id
     WHERE business_id = p_business_id AND movement_type = 'safe_drop'
       AND (gl_debit_account_id IS NULL OR gl_credit_account_id IS NULL);

    -- petty_cash_out: Dr Petty Cash, Cr Cash
    UPDATE pos_cash_movement_types SET
      gl_debit_account_id  = v_petty_id,
      gl_credit_account_id = v_cash_id
     WHERE business_id = p_business_id AND movement_type = 'petty_cash_out'
       AND (gl_debit_account_id IS NULL OR gl_credit_account_id IS NULL);
  END IF;

  -- bank_deposit: Dr Bank, Cr Cash
  IF v_bank_id IS NOT NULL AND v_cash_id IS NOT NULL THEN
    UPDATE pos_cash_movement_types SET
      gl_debit_account_id  = v_bank_id,
      gl_credit_account_id = v_cash_id
     WHERE business_id = p_business_id AND movement_type = 'bank_deposit'
       AND (gl_debit_account_id IS NULL OR gl_credit_account_id IS NULL);
  END IF;

  -- opening_float and correction intentionally left NULL — these depend on
  -- per-business policy (e.g. dedicated Till vs Safe sub-accounts, Cash Over/Short).
  -- Surface a readiness warning rather than guess.
END$$;

-- Run once for every existing business
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT id FROM businesses LOOP
    PERFORM public.seed_pos_cash_movement_type_defaults(r.id);
  END LOOP;
END$$;

-- ---------- G1 + G2 + G5: Harden process_pos_cash_movement RPC ----------

CREATE OR REPLACE FUNCTION public.process_pos_cash_movement(
  p_organization_id uuid,
  p_business_id     uuid,
  p_shift_id        uuid,
  p_register_id     uuid,
  p_movement_type   text,
  p_amount          numeric,
  p_reason_code     text DEFAULT NULL,
  p_reason          text DEFAULT NULL,
  p_notes           text DEFAULT NULL,
  p_performed_by    uuid DEFAULT NULL,
  p_override_id     uuid DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_shift     record;
  v_register  record;
  v_type      record;
  v_settings  record;
  v_threshold numeric := 0;
  v_signed_delta numeric;
  v_movement_id uuid;
  v_je_id     uuid;
  v_je_number text;
  v_lines     jsonb;
  v_user_id   uuid := COALESCE(p_performed_by, auth.uid());
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'amount must be positive' USING ERRCODE = '22023';
  END IF;

  -- G5: scope role check to POS module create permission
  IF NOT public.user_has_module_permission(v_user_id, p_organization_id, p_business_id, 'pos', 'create') THEN
    RAISE EXCEPTION 'user lacks POS create permission for this business' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_shift FROM pos_shifts WHERE id = p_shift_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'shift not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_shift.status <> 'open' THEN
    RAISE EXCEPTION 'shift is not open' USING ERRCODE = '22023';
  END IF;
  IF v_shift.register_id <> p_register_id THEN
    RAISE EXCEPTION 'register does not match shift' USING ERRCODE = '22023';
  END IF;
  IF v_shift.business_id <> p_business_id OR v_shift.organization_id <> p_organization_id THEN
    RAISE EXCEPTION 'shift does not belong to provided business/org' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_register FROM pos_registers WHERE id = p_register_id;
  IF NOT FOUND OR v_register.business_id <> p_business_id THEN
    RAISE EXCEPTION 'register not found in business' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_type
    FROM pos_cash_movement_types
   WHERE business_id = p_business_id
     AND movement_type = p_movement_type
     AND is_active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'movement type % not configured for business', p_movement_type USING ERRCODE = '22023';
  END IF;

  IF v_type.requires_reason
     AND COALESCE(NULLIF(TRIM(COALESCE(p_reason_code, p_reason, '')), ''), NULL) IS NULL THEN
    RAISE EXCEPTION 'reason is required for % movements', p_movement_type USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_settings
    FROM pos_security_settings
   WHERE business_id = p_business_id
   ORDER BY created_at ASC
   LIMIT 1;

  v_threshold := CASE p_movement_type
    WHEN 'cash_out'     THEN COALESCE(v_settings.cash_out_requires_manager_above_amount, 0)
    WHEN 'safe_drop'    THEN COALESCE(v_settings.safe_drop_requires_manager_above_amount, 0)
    WHEN 'bank_deposit' THEN COALESCE(v_settings.bank_deposit_requires_manager_above_amount, 0)
    ELSE 0
  END;

  IF (v_type.requires_manager_default OR (v_threshold > 0 AND p_amount > v_threshold))
     AND p_override_id IS NULL THEN
    RAISE EXCEPTION 'manager_override_required'
      USING ERRCODE = '42501', HINT = 'movement type or amount requires manager approval';
  END IF;

  -- G2: tighten override scope (org + register + shift + status approved + not consumed)
  IF p_override_id IS NOT NULL THEN
    PERFORM 1 FROM pos_manager_overrides
      WHERE id = p_override_id
        AND organization_id = p_organization_id
        AND register_id = p_register_id
        AND (shift_id IS NULL OR shift_id = p_shift_id)
        AND status = 'approved'
        AND consumed_at IS NULL
      FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'invalid or already-used manager override' USING ERRCODE = '42501';
    END IF;
  END IF;

  v_signed_delta := CASE p_movement_type
    WHEN 'opening_float' THEN  p_amount
    WHEN 'cash_in'       THEN  p_amount
    WHEN 'correction'    THEN  p_amount
    WHEN 'cash_out'      THEN -p_amount
    WHEN 'pickup'        THEN -p_amount
    WHEN 'safe_drop'     THEN -p_amount
    WHEN 'bank_deposit'  THEN -p_amount
    WHEN 'petty_cash_out'THEN -p_amount
    ELSE 0
  END;

  INSERT INTO pos_cash_movements (
    organization_id, business_id, branch_id, shift_id, register_id,
    movement_type, amount, reason_code, reason, notes,
    performed_by, manager_override_id
  ) VALUES (
    p_organization_id, p_business_id, v_shift.branch_id, p_shift_id, p_register_id,
    p_movement_type, p_amount, p_reason_code, p_reason, p_notes,
    v_user_id, p_override_id
  ) RETURNING id INTO v_movement_id;

  UPDATE pos_shifts
     SET expected_cash = COALESCE(expected_cash, 0) + v_signed_delta,
         updated_at    = now()
   WHERE id = p_shift_id;

  IF v_type.gl_debit_account_id IS NOT NULL AND v_type.gl_credit_account_id IS NOT NULL THEN
    SELECT public.get_next_journal_entry_number(p_organization_id) INTO v_je_number;

    v_lines := jsonb_build_array(
      jsonb_build_object(
        'account_id', v_type.gl_debit_account_id,
        'debit',  p_amount,
        'credit', 0,
        'description', concat('POS ', p_movement_type, ' — shift ', v_shift.shift_number)
      ),
      jsonb_build_object(
        'account_id', v_type.gl_credit_account_id,
        'debit',  0,
        'credit', p_amount,
        'description', concat('POS ', p_movement_type, ' — shift ', v_shift.shift_number)
      )
    );

    SELECT (public.post_journal_entry_atomic(
      p_organization_id,
      p_business_id,
      v_je_number,
      CURRENT_DATE,
      concat('POS-CASH-', v_movement_id::text),
      concat('POS cash movement: ', v_type.label),
      'pos_cash_movement',
      v_movement_id,
      v_user_id,
      false,
      false,
      v_lines,
      NULL,
      1,
      p_movement_type,
      v_shift.branch_id
    ))::uuid INTO v_je_id;

    UPDATE pos_cash_movements
       SET journal_entry_id = v_je_id
     WHERE id = v_movement_id;
  END IF;

  -- G2: consume the override after success so it can't be replayed
  IF p_override_id IS NOT NULL THEN
    UPDATE pos_manager_overrides
       SET status         = 'consumed',
           consumed_at    = now(),
           consumed_table = 'pos_cash_movements',
           consumed_ref_id = v_movement_id
     WHERE id = p_override_id;
  END IF;

  RETURN json_build_object(
    'success', true,
    'movement_id', v_movement_id,
    'journal_entry_id', v_je_id,
    'gl_posted', v_je_id IS NOT NULL,
    'expected_cash_delta', v_signed_delta
  );
END;
$$;
