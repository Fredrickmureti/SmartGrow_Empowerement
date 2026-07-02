
ALTER TABLE public.pos_cash_movements
  DROP CONSTRAINT IF EXISTS pos_cash_movements_movement_type_check;

ALTER TABLE public.pos_cash_movements
  ADD CONSTRAINT pos_cash_movements_movement_type_check
  CHECK (movement_type = ANY (ARRAY[
    'opening_float','cash_in','cash_out','float','pickup','drop',
    'safe_drop','bank_deposit','petty_cash_out','correction'
  ]));

UPDATE public.pos_cash_movements
   SET movement_type = 'opening_float'
 WHERE movement_type = 'float';

ALTER TABLE public.pos_cash_movements
  ADD COLUMN IF NOT EXISTS reason_code text,
  ADD COLUMN IF NOT EXISTS manager_override_id uuid
    REFERENCES public.pos_manager_overrides(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS journal_entry_id uuid
    REFERENCES public.journal_entries(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS public.pos_cash_movement_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  movement_type text NOT NULL,
  label text NOT NULL,
  description text,
  requires_reason boolean NOT NULL DEFAULT false,
  requires_manager_default boolean NOT NULL DEFAULT false,
  gl_debit_account_id uuid REFERENCES public.accounts(id),
  gl_credit_account_id uuid REFERENCES public.accounts(id),
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, movement_type),
  CHECK (movement_type = ANY (ARRAY[
    'opening_float','cash_in','cash_out','pickup','safe_drop',
    'bank_deposit','petty_cash_out','correction'
  ]))
);

CREATE INDEX IF NOT EXISTS idx_pos_cash_movement_types_business
  ON public.pos_cash_movement_types(business_id);

ALTER TABLE public.pos_cash_movement_types ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "pos_cash_movement_types read" ON public.pos_cash_movement_types;
CREATE POLICY "pos_cash_movement_types read" ON public.pos_cash_movement_types
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles ur
       WHERE ur.user_id = auth.uid()
         AND ur.organization_id = pos_cash_movement_types.organization_id
         AND ur.is_active = true
    )
  );

DROP POLICY IF EXISTS "pos_cash_movement_types manage" ON public.pos_cash_movement_types;
CREATE POLICY "pos_cash_movement_types manage" ON public.pos_cash_movement_types
  FOR ALL TO authenticated
  USING (
    public.has_role(auth.uid(), organization_id, 'admin'::app_role)
    OR public.has_role(auth.uid(), organization_id, 'owner'::app_role)
  )
  WITH CHECK (
    public.has_role(auth.uid(), organization_id, 'admin'::app_role)
    OR public.has_role(auth.uid(), organization_id, 'owner'::app_role)
  );

INSERT INTO public.pos_cash_movement_types
  (organization_id, business_id, movement_type, label, requires_reason, requires_manager_default, sort_order)
SELECT b.organization_id, b.id, t.movement_type, t.label, t.requires_reason, t.requires_manager, t.sort_order
FROM public.businesses b
CROSS JOIN (VALUES
  ('opening_float',  'Opening Float',   false, false, 10),
  ('cash_in',        'Cash In',         true,  false, 20),
  ('cash_out',       'Cash Out',        true,  true,  30),
  ('pickup',         'Cash Pickup',     true,  true,  40),
  ('safe_drop',      'Safe Drop',       true,  true,  50),
  ('bank_deposit',   'Bank Deposit',    true,  true,  60),
  ('petty_cash_out', 'Petty Cash Out',  true,  true,  70),
  ('correction',     'Cash Correction', true,  true,  80)
) AS t(movement_type, label, requires_reason, requires_manager, sort_order)
ON CONFLICT (business_id, movement_type) DO NOTHING;

ALTER TABLE public.pos_security_settings
  ADD COLUMN IF NOT EXISTS cash_out_requires_manager_above_amount numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS safe_drop_requires_manager_above_amount numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bank_deposit_requires_manager_above_amount numeric NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION public.process_pos_cash_movement(
  p_organization_id uuid,
  p_business_id uuid,
  p_shift_id uuid,
  p_register_id uuid,
  p_movement_type text,
  p_amount numeric,
  p_reason_code text DEFAULT NULL,
  p_reason text DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_performed_by uuid DEFAULT NULL,
  p_override_id uuid DEFAULT NULL
) RETURNS json
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_shift record;
  v_register record;
  v_type record;
  v_settings record;
  v_threshold numeric := 0;
  v_signed_delta numeric;
  v_movement_id uuid;
  v_je_id uuid;
  v_je_number text;
  v_lines jsonb;
  v_user_id uuid := COALESCE(p_performed_by, auth.uid());
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'amount must be positive' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM user_roles ur
     WHERE ur.user_id = v_user_id
       AND ur.organization_id = p_organization_id
       AND ur.is_active = true
  ) THEN
    RAISE EXCEPTION 'user not authorized for organization' USING ERRCODE = '42501';
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

  IF p_override_id IS NOT NULL THEN
    PERFORM 1 FROM pos_manager_overrides
      WHERE id = p_override_id
        AND organization_id = p_organization_id
        AND register_id = p_register_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'invalid manager override' USING ERRCODE = '42501';
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
         updated_at = now()
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

  RETURN json_build_object(
    'success', true,
    'movement_id', v_movement_id,
    'journal_entry_id', v_je_id,
    'expected_cash_delta', v_signed_delta
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.process_pos_cash_movement(
  uuid, uuid, uuid, uuid, text, numeric, text, text, text, uuid, uuid
) TO authenticated;

CREATE OR REPLACE VIEW public.v_pos_cash_expected AS
SELECT
  s.id AS shift_id,
  s.organization_id,
  s.business_id,
  s.branch_id,
  s.register_id,
  s.opening_cash,
  COALESCE(s.cash_payments, 0) AS cash_sales,
  COALESCE((
    SELECT SUM(CASE m.movement_type
                 WHEN 'opening_float' THEN  m.amount
                 WHEN 'cash_in'       THEN  m.amount
                 WHEN 'correction'    THEN  m.amount
                 WHEN 'float'         THEN  m.amount
                 WHEN 'cash_out'      THEN -m.amount
                 WHEN 'pickup'        THEN -m.amount
                 WHEN 'drop'          THEN -m.amount
                 WHEN 'safe_drop'     THEN -m.amount
                 WHEN 'bank_deposit'  THEN -m.amount
                 WHEN 'petty_cash_out'THEN -m.amount
                 ELSE 0
               END)
      FROM pos_cash_movements m
     WHERE m.shift_id = s.id
  ), 0) AS movements_net,
  COALESCE(s.opening_cash, 0)
    + COALESCE(s.cash_payments, 0)
    + COALESCE((
        SELECT SUM(CASE m.movement_type
                     WHEN 'opening_float' THEN  m.amount
                     WHEN 'cash_in'       THEN  m.amount
                     WHEN 'correction'    THEN  m.amount
                     WHEN 'float'         THEN  m.amount
                     WHEN 'cash_out'      THEN -m.amount
                     WHEN 'pickup'        THEN -m.amount
                     WHEN 'drop'          THEN -m.amount
                     WHEN 'safe_drop'     THEN -m.amount
                     WHEN 'bank_deposit'  THEN -m.amount
                     WHEN 'petty_cash_out'THEN -m.amount
                     ELSE 0
                   END)
          FROM pos_cash_movements m
         WHERE m.shift_id = s.id
      ), 0) AS expected_cash_computed,
  s.actual_cash,
  s.status
FROM pos_shifts s;

GRANT SELECT ON public.v_pos_cash_expected TO authenticated;

DROP TRIGGER IF EXISTS trg_pos_cash_movement_types_updated_at ON public.pos_cash_movement_types;
CREATE TRIGGER trg_pos_cash_movement_types_updated_at
  BEFORE UPDATE ON public.pos_cash_movement_types
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
