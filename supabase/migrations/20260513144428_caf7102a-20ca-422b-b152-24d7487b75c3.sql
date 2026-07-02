-- Fix POS force-close override wiring: p_override_id is a pos_manager_overrides.id,
-- not a pos_manager_pins.id. Writing it to variance_override_pin_id violates
-- pos_shifts_variance_override_pin_id_fkey.
CREATE OR REPLACE FUNCTION public.enforce_pos_shift_cash_variance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_diff numeric;
  v_has_override boolean;
BEGIN
  IF NEW.status <> 'closed' OR OLD.status = 'closed' THEN
    RETURN NEW;
  END IF;

  IF NEW.actual_cash IS NULL THEN
    RAISE EXCEPTION 'Cannot close shift %: cash count is required.', COALESCE(NEW.shift_number, NEW.id::text)
      USING ERRCODE = 'check_violation';
  END IF;

  v_diff := COALESCE(NEW.actual_cash, 0) - COALESCE(NEW.expected_cash, 0);
  NEW.cash_difference := v_diff;

  v_has_override :=
       NEW.variance_override_pin_id IS NOT NULL
    OR NEW.variance_override_id IS NOT NULL;

  IF abs(v_diff) > COALESCE(NEW.cash_variance_tolerance, 0) AND NOT v_has_override THEN
    RAISE EXCEPTION 'Cash variance % exceeds tolerance % for shift %. Manager override required.',
      to_char(v_diff, 'FM999G999G990D00'),
      to_char(COALESCE(NEW.cash_variance_tolerance, 0), 'FM999G999G990D00'),
      COALESCE(NEW.shift_number, NEW.id::text)
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.force_close_pos_shift(
  p_shift_id    uuid,
  p_reason      text,
  p_override_id uuid,
  p_actual_cash numeric DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_shift         public.pos_shifts;
  v_expected      numeric := 0;
  v_actual        numeric;
  v_variance      numeric;
  v_register_name text;
BEGIN
  IF COALESCE(btrim(p_reason),'') = '' THEN
    RAISE EXCEPTION 'A reason is required for a force-close' USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_shift FROM public.pos_shifts WHERE id = p_shift_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Shift not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_shift.status <> 'open' THEN
    RAISE EXCEPTION 'Shift % is not open (status=%)', COALESCE(v_shift.shift_number, v_shift.id::text), v_shift.status
      USING ERRCODE = 'check_violation';
  END IF;

  PERFORM public.assert_manager_override(
    'force_close_shift',
    0,
    v_shift.organization_id,
    v_shift.business_id,
    p_shift_id,
    p_override_id,
    'pos_shifts',
    p_shift_id
  );

  SELECT COALESCE(expected_cash_computed, v_shift.expected_cash, 0)
    INTO v_expected
  FROM public.v_pos_cash_expected
  WHERE shift_id = p_shift_id;
  IF v_expected IS NULL THEN v_expected := COALESCE(v_shift.expected_cash, 0); END IF;

  v_actual   := COALESCE(p_actual_cash, 0);
  v_variance := v_actual - v_expected;

  PERFORM set_config('pos.allow_close', 'true', true);

  UPDATE public.pos_shifts
     SET status                = 'closed',
         closed_at             = now(),
         closed_by             = auth.uid(),
         actual_cash           = v_actual,
         expected_cash         = v_expected,
         cash_difference       = v_variance,
         variance_override_id  = p_override_id,
         force_closed_by       = auth.uid(),
         force_close_reason    = p_reason,
         close_blocked_reasons = '[]'::jsonb,
         notes                 = COALESCE(notes,'') || E'\n[FORCE-CLOSE] ' || p_reason,
         updated_at            = now()
   WHERE id = p_shift_id;

  UPDATE public.pos_manager_overrides
     SET amount = abs(v_variance),
         metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
           'expected_cash', v_expected,
           'actual_cash', v_actual,
           'cash_variance', v_variance,
           'force_close_reason', p_reason
         )
   WHERE id = p_override_id;

  SELECT register_name INTO v_register_name
    FROM public.pos_registers WHERE id = v_shift.register_id;

  INSERT INTO public.admin_audit_log
    (admin_user_id, action_type, target_org_id, target_entity_type, target_entity_id, details)
  VALUES
    (auth.uid(), 'pos.shift.force_close', v_shift.organization_id, 'pos_shifts', p_shift_id::text,
     jsonb_build_object('reason', p_reason, 'override_id', p_override_id,
                        'shift_number', v_shift.shift_number,
                        'register_name', v_register_name,
                        'expected', v_expected, 'actual', v_actual, 'variance', v_variance));

  RETURN jsonb_build_object(
    'success', true,
    'shift_number', v_shift.shift_number,
    'register_name', v_register_name,
    'expected_cash', v_expected,
    'actual_cash', v_actual,
    'variance', v_variance,
    'journal_entry_id', (SELECT journal_entry_id FROM public.pos_shifts WHERE id = p_shift_id)
  );
END $$;

GRANT EXECUTE ON FUNCTION public.force_close_pos_shift(uuid,text,uuid,numeric) TO authenticated;