
-- =========================================================
-- Stage 7 — POS shift correctness
-- =========================================================

-- B. Schema: tighter active-shift uniqueness + new columns
DROP INDEX IF EXISTS public.idx_pos_shifts_one_open_per_user_register;

CREATE UNIQUE INDEX IF NOT EXISTS uq_pos_shifts_one_open_per_register
  ON public.pos_shifts (register_id)
  WHERE status = 'open';

CREATE UNIQUE INDEX IF NOT EXISTS uq_pos_shifts_one_open_per_cashier
  ON public.pos_shifts (COALESCE(cashier_id, user_id))
  WHERE status = 'open';

ALTER TABLE public.pos_shifts
  ADD COLUMN IF NOT EXISTS close_blocked_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS variance_override_id uuid REFERENCES public.pos_manager_overrides(id);

ALTER TABLE public.pos_security_settings
  ADD COLUMN IF NOT EXISTS shift_variance_requires_manager_above_amount numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS require_denomination_count boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS allow_blind_close boolean NOT NULL DEFAULT true;

-- C. Gate function
CREATE OR REPLACE FUNCTION public.can_close_pos_shift(p_shift_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_shift            public.pos_shifts;
  v_reasons          jsonb := '[]'::jsonb;
  v_held_count       int;
  v_pending_count    int;
  v_unposted_count   int;
  v_open_return_cnt  int;
BEGIN
  SELECT * INTO v_shift FROM public.pos_shifts WHERE id = p_shift_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reasons',
      jsonb_build_array(jsonb_build_object('code','not_found','message','Shift not found')));
  END IF;

  IF v_shift.status <> 'open' THEN
    RETURN jsonb_build_object('ok', false, 'reasons',
      jsonb_build_array(jsonb_build_object('code','not_open','message','Shift is not open')));
  END IF;

  IF NOT public.user_has_module_permission(
       auth.uid(), v_shift.organization_id, v_shift.business_id, 'pos', 'update') THEN
    RETURN jsonb_build_object('ok', false, 'reasons',
      jsonb_build_array(jsonb_build_object('code','forbidden','message','You do not have permission to close this shift')));
  END IF;

  -- Held orders
  SELECT count(*) INTO v_held_count
  FROM public.pos_held_transactions
  WHERE shift_id = p_shift_id AND status = 'held';
  IF v_held_count > 0 THEN
    v_reasons := v_reasons || jsonb_build_array(jsonb_build_object(
      'code','held_orders','message', v_held_count || ' held order(s) must be recalled or voided','count',v_held_count));
  END IF;

  -- In-flight (non-completed) transactions
  SELECT count(*) INTO v_pending_count
  FROM public.pos_transactions
  WHERE shift_id = p_shift_id
    AND status NOT IN ('completed','voided','refunded');
  IF v_pending_count > 0 THEN
    v_reasons := v_reasons || jsonb_build_array(jsonb_build_object(
      'code','pending_transactions','message', v_pending_count || ' transaction(s) still in progress','count',v_pending_count));
  END IF;

  -- Unposted completed sales (no journal entry yet) — only if the column exists
  BEGIN
    SELECT count(*) INTO v_unposted_count
    FROM public.pos_transactions t
    WHERE t.shift_id = p_shift_id
      AND t.status = 'completed'
      AND t.transaction_type = 'sale'
      AND NOT EXISTS (
        SELECT 1 FROM public.journal_entries je
        WHERE je.source_type IN ('pos_transaction','pos_sale')
          AND je.source_id = t.id
          AND je.status <> 'voided'
      );
    -- We do NOT block on per-txn JE because shift close posts the aggregated JE.
    -- Kept here as informational only.
  EXCEPTION WHEN OTHERS THEN
    v_unposted_count := 0;
  END;

  RETURN jsonb_build_object(
    'ok', jsonb_array_length(v_reasons) = 0,
    'reasons', v_reasons,
    'shift_id', p_shift_id,
    'held_count', v_held_count,
    'pending_count', v_pending_count
  );
END;
$$;

-- D. RPC: close_pos_shift
CREATE OR REPLACE FUNCTION public.close_pos_shift(
  p_shift_id uuid,
  p_actual_cash numeric,
  p_notes text DEFAULT NULL,
  p_blind_close boolean DEFAULT false,
  p_manager_override_id uuid DEFAULT NULL,
  p_denomination_counted boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_shift        public.pos_shifts;
  v_gate         jsonb;
  v_expected     numeric := 0;
  v_variance     numeric := 0;
  v_threshold    numeric := 0;
  v_require_denom boolean := false;
  v_allow_blind  boolean := true;
  v_override     public.pos_manager_overrides;
  v_actual       numeric;
BEGIN
  -- Lock the shift
  SELECT * INTO v_shift FROM public.pos_shifts WHERE id = p_shift_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Shift not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_shift.status <> 'open' THEN
    RAISE EXCEPTION 'Shift is not open (status=%)', v_shift.status USING ERRCODE = 'check_violation';
  END IF;

  -- Gate
  v_gate := public.can_close_pos_shift(p_shift_id);
  IF NOT (v_gate->>'ok')::boolean THEN
    UPDATE public.pos_shifts SET close_blocked_reasons = (v_gate->'reasons')
     WHERE id = p_shift_id;
    RAISE EXCEPTION 'Cannot close shift: %', v_gate->>'reasons'
      USING ERRCODE = 'check_violation', DETAIL = (v_gate->>'reasons');
  END IF;

  -- Settings
  SELECT
    COALESCE(shift_variance_requires_manager_above_amount, 0),
    COALESCE(require_denomination_count, false),
    COALESCE(allow_blind_close, true)
  INTO v_threshold, v_require_denom, v_allow_blind
  FROM public.pos_security_settings
  WHERE organization_id = v_shift.organization_id
    AND (business_id IS NULL OR business_id = v_shift.business_id)
  ORDER BY business_id NULLS LAST
  LIMIT 1;

  IF p_blind_close AND NOT v_allow_blind THEN
    RAISE EXCEPTION 'Blind close is disabled for this business' USING ERRCODE = 'check_violation';
  END IF;

  IF NOT p_blind_close AND v_require_denom AND NOT p_denomination_counted THEN
    RAISE EXCEPTION 'Denomination count is required to close this shift' USING ERRCODE = 'check_violation';
  END IF;

  -- Expected cash from canonical view
  SELECT COALESCE(expected_cash_computed, v_shift.expected_cash, 0)
    INTO v_expected
  FROM public.v_pos_cash_expected
  WHERE shift_id = p_shift_id;
  IF v_expected IS NULL THEN v_expected := COALESCE(v_shift.expected_cash, 0); END IF;

  v_actual := CASE WHEN p_blind_close THEN v_expected ELSE p_actual_cash END;
  v_variance := v_actual - v_expected;

  -- Variance gate
  IF NOT p_blind_close AND v_threshold > 0 AND abs(v_variance) > v_threshold THEN
    IF p_manager_override_id IS NULL THEN
      RAISE EXCEPTION 'Variance % exceeds threshold %; manager approval required',
        v_variance, v_threshold USING ERRCODE = 'check_violation';
    END IF;

    SELECT * INTO v_override
    FROM public.pos_manager_overrides
    WHERE id = p_manager_override_id FOR UPDATE;
    IF NOT FOUND
       OR v_override.status <> 'approved'
       OR v_override.consumed_at IS NOT NULL
       OR v_override.organization_id <> v_shift.organization_id
       OR v_override.business_id IS DISTINCT FROM v_shift.business_id
       OR (v_override.shift_id IS NOT NULL AND v_override.shift_id <> p_shift_id) THEN
      RAISE EXCEPTION 'Manager override invalid, expired, or already consumed' USING ERRCODE = 'check_violation';
    END IF;

    UPDATE public.pos_manager_overrides
       SET status = 'consumed',
           consumed_at = now(),
           consumed_table = 'pos_shifts',
           consumed_ref_id = p_shift_id
     WHERE id = p_manager_override_id;
  END IF;

  -- Close
  UPDATE public.pos_shifts
     SET status = 'closed',
         closed_at = now(),
         closed_by = auth.uid(),
         actual_cash = v_actual,
         expected_cash = v_expected,
         cash_difference = v_variance,
         variance_override_id = p_manager_override_id,
         close_blocked_reasons = '[]'::jsonb,
         notes = COALESCE(p_notes, notes),
         updated_at = now()
   WHERE id = p_shift_id;

  -- GL posting is done by trg_pos_shift_close_journal AFTER UPDATE.

  RETURN jsonb_build_object(
    'success', true,
    'shift_id', p_shift_id,
    'expected_cash', v_expected,
    'actual_cash', v_actual,
    'variance', v_variance,
    'journal_entry_id', (SELECT journal_entry_id FROM public.pos_shifts WHERE id = p_shift_id)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.close_pos_shift(uuid, numeric, text, boolean, uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.close_pos_shift(uuid, numeric, text, boolean, uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_close_pos_shift(uuid) TO authenticated;

-- E. Closed-shift RLS: lock writes once status='closed'
DROP POLICY IF EXISTS "Users can update their POS shifts" ON public.pos_shifts;
CREATE POLICY "Users can update open POS shifts"
ON public.pos_shifts
FOR UPDATE
USING (
  status = 'open'
  AND EXISTS (SELECT 1 FROM user_roles ur
    WHERE ur.user_id = auth.uid()
      AND ur.organization_id = pos_shifts.organization_id
      AND ur.is_active = true)
  AND can_access_branch(auth.uid(), branch_id)
)
WITH CHECK (
  EXISTS (SELECT 1 FROM user_roles ur
    WHERE ur.user_id = auth.uid()
      AND ur.organization_id = pos_shifts.organization_id
      AND ur.is_active = true)
  AND can_access_branch(auth.uid(), branch_id)
);
