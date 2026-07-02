-- =========================================================================
-- POS STAGE 8 — Override matrix + audit hardening
-- =========================================================================

-- ---------- 1. New columns on pos_shifts ----------
ALTER TABLE public.pos_shifts
  ADD COLUMN IF NOT EXISTS reopened_at      timestamptz,
  ADD COLUMN IF NOT EXISTS reopened_by      uuid,
  ADD COLUMN IF NOT EXISTS reopen_reason    text,
  ADD COLUMN IF NOT EXISTS reopen_count     int  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS force_closed_by  uuid,
  ADD COLUMN IF NOT EXISTS force_close_reason text;

-- ---------- 2. pos_override_matrix table ----------
CREATE TABLE IF NOT EXISTS public.pos_override_matrix (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id         uuid REFERENCES public.businesses(id) ON DELETE CASCADE, -- null = org-wide default
  action              text NOT NULL,
  threshold_amount    numeric NOT NULL DEFAULT 0,
  require_pin         boolean NOT NULL DEFAULT true,
  restricted_roles    text[] NOT NULL DEFAULT '{}',  -- app_role names; empty = any approver
  is_active           boolean NOT NULL DEFAULT true,
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid,
  CONSTRAINT pos_override_matrix_action_chk CHECK (action IN (
    'void_transaction','void_above_threshold','refund','cross_tender_refund',
    'discount_over_limit','price_change','manual_price','delete_item','no_sale',
    'cash_drop','cash_out_above_threshold','safe_drop','bank_deposit',
    'shift_variance','reopen_shift','force_close_shift','override_age_check'
  ))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_pos_override_matrix_org_biz_action
  ON public.pos_override_matrix (organization_id, COALESCE(business_id, '00000000-0000-0000-0000-000000000000'::uuid), action);

CREATE INDEX IF NOT EXISTS idx_pos_override_matrix_org_active
  ON public.pos_override_matrix (organization_id, is_active);

ALTER TABLE public.pos_override_matrix ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "members read pos_override_matrix" ON public.pos_override_matrix;
CREATE POLICY "members read pos_override_matrix"
  ON public.pos_override_matrix FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.user_roles ur
     WHERE ur.user_id = auth.uid()
       AND ur.organization_id = pos_override_matrix.organization_id
       AND ur.is_active = true
  ));

DROP POLICY IF EXISTS "admins write pos_override_matrix" ON public.pos_override_matrix;
CREATE POLICY "admins write pos_override_matrix"
  ON public.pos_override_matrix FOR ALL TO authenticated
  USING (
    public.has_role(auth.uid(), organization_id, 'owner'::public.app_role) OR
    public.has_role(auth.uid(), organization_id, 'admin'::public.app_role) OR
    public.has_role(auth.uid(), organization_id, 'super_admin'::public.app_role)
  )
  WITH CHECK (
    public.has_role(auth.uid(), organization_id, 'owner'::public.app_role) OR
    public.has_role(auth.uid(), organization_id, 'admin'::public.app_role) OR
    public.has_role(auth.uid(), organization_id, 'super_admin'::public.app_role)
  );

CREATE OR REPLACE FUNCTION public._pos_override_matrix_touch()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS trg_pos_override_matrix_touch ON public.pos_override_matrix;
CREATE TRIGGER trg_pos_override_matrix_touch
  BEFORE UPDATE ON public.pos_override_matrix
  FOR EACH ROW EXECUTE FUNCTION public._pos_override_matrix_touch();

-- ---------- 3. Seed matrix from existing pos_security_settings ----------
DO $seed$
DECLARE
  s RECORD;
  v_actions jsonb;
  v_action text;
  v_threshold numeric;
  v_require boolean;
  v_restricted text[] := ARRAY['owner','admin','super_admin']::text[];
BEGIN
  FOR s IN SELECT * FROM public.pos_security_settings LOOP
    -- void_above_threshold (used by process_pos_void)
    INSERT INTO public.pos_override_matrix (organization_id, business_id, action, threshold_amount, require_pin)
    VALUES (s.organization_id, s.business_id, 'void_above_threshold',
            COALESCE(s.void_requires_manager_above_amount,0),
            COALESCE(s.require_manager_pin_for_void,false))
    ON CONFLICT (organization_id, COALESCE(business_id, '00000000-0000-0000-0000-000000000000'::uuid), action) DO NOTHING;

    -- refund (general) + cross_tender_refund (used by process_pos_return)
    INSERT INTO public.pos_override_matrix (organization_id, business_id, action, threshold_amount, require_pin)
    VALUES (s.organization_id, s.business_id, 'refund',
            COALESCE(s.return_requires_manager_above_amount,0),
            COALESCE(s.require_manager_pin_for_return,false))
    ON CONFLICT (organization_id, COALESCE(business_id, '00000000-0000-0000-0000-000000000000'::uuid), action) DO NOTHING;

    INSERT INTO public.pos_override_matrix (organization_id, business_id, action, threshold_amount, require_pin)
    VALUES (s.organization_id, s.business_id, 'cross_tender_refund', 0, true)
    ON CONFLICT (organization_id, COALESCE(business_id, '00000000-0000-0000-0000-000000000000'::uuid), action) DO NOTHING;

    -- cash control
    INSERT INTO public.pos_override_matrix (organization_id, business_id, action, threshold_amount, require_pin)
    VALUES (s.organization_id, s.business_id, 'cash_out_above_threshold',
            COALESCE(s.cash_out_requires_manager_above_amount,0), true)
    ON CONFLICT (organization_id, COALESCE(business_id, '00000000-0000-0000-0000-000000000000'::uuid), action) DO NOTHING;

    INSERT INTO public.pos_override_matrix (organization_id, business_id, action, threshold_amount, require_pin)
    VALUES (s.organization_id, s.business_id, 'safe_drop',
            COALESCE(s.safe_drop_requires_manager_above_amount,0), true)
    ON CONFLICT (organization_id, COALESCE(business_id, '00000000-0000-0000-0000-000000000000'::uuid), action) DO NOTHING;

    INSERT INTO public.pos_override_matrix (organization_id, business_id, action, threshold_amount, require_pin)
    VALUES (s.organization_id, s.business_id, 'bank_deposit',
            COALESCE(s.bank_deposit_requires_manager_above_amount,0), true)
    ON CONFLICT (organization_id, COALESCE(business_id, '00000000-0000-0000-0000-000000000000'::uuid), action) DO NOTHING;

    -- discount
    INSERT INTO public.pos_override_matrix (organization_id, business_id, action, threshold_amount, require_pin)
    VALUES (s.organization_id, s.business_id, 'discount_over_limit',
            COALESCE(s.discount_limit_requires_approval,0),
            COALESCE(s.require_manager_pin_for_discount,false))
    ON CONFLICT (organization_id, COALESCE(business_id, '00000000-0000-0000-0000-000000000000'::uuid), action) DO NOTHING;

    -- shift variance
    INSERT INTO public.pos_override_matrix (organization_id, business_id, action, threshold_amount, require_pin)
    VALUES (s.organization_id, s.business_id, 'shift_variance',
            COALESCE(s.shift_variance_requires_manager_above_amount,0), true)
    ON CONFLICT (organization_id, COALESCE(business_id, '00000000-0000-0000-0000-000000000000'::uuid), action) DO NOTHING;

    -- admin-only actions (always need PIN, restricted to admin/owner roles)
    INSERT INTO public.pos_override_matrix (organization_id, business_id, action, threshold_amount, require_pin, restricted_roles)
    VALUES (s.organization_id, s.business_id, 'reopen_shift', 0, true, v_restricted)
    ON CONFLICT (organization_id, COALESCE(business_id, '00000000-0000-0000-0000-000000000000'::uuid), action) DO NOTHING;

    INSERT INTO public.pos_override_matrix (organization_id, business_id, action, threshold_amount, require_pin, restricted_roles)
    VALUES (s.organization_id, s.business_id, 'force_close_shift', 0, true, v_restricted)
    ON CONFLICT (organization_id, COALESCE(business_id, '00000000-0000-0000-0000-000000000000'::uuid), action) DO NOTHING;
  END LOOP;
END $seed$;

-- ---------- 4. assert_manager_override helper ----------
CREATE OR REPLACE FUNCTION public.assert_manager_override(
  p_action          text,
  p_amount          numeric,
  p_organization_id uuid,
  p_business_id     uuid,
  p_shift_id        uuid,
  p_override_id     uuid,
  p_consumed_table  text DEFAULT NULL,
  p_consumed_ref_id uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_matrix     public.pos_override_matrix;
  v_ovr        public.pos_manager_overrides;
  v_role_ok    boolean;
BEGIN
  SELECT * INTO v_matrix
    FROM public.pos_override_matrix
   WHERE organization_id = p_organization_id
     AND action = p_action
     AND is_active = true
     AND (business_id IS NULL OR business_id = p_business_id)
   ORDER BY business_id NULLS LAST
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN NULL; -- no enforcement configured
  END IF;

  IF COALESCE(p_amount,0) <= COALESCE(v_matrix.threshold_amount,0)
     AND v_matrix.require_pin = false THEN
    RETURN NULL;
  END IF;

  IF p_override_id IS NULL THEN
    RAISE EXCEPTION 'override_required'
      USING ERRCODE = '42501',
            HINT    = format('Action %s requires manager approval (threshold=%s, amount=%s)',
                             p_action, v_matrix.threshold_amount, COALESCE(p_amount,0)),
            DETAIL  = jsonb_build_object(
                        'action',    p_action,
                        'threshold', v_matrix.threshold_amount,
                        'amount',    COALESCE(p_amount,0)
                      )::text;
  END IF;

  SELECT * INTO v_ovr FROM public.pos_manager_overrides
    WHERE id = p_override_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'override_not_found' USING ERRCODE = '42501';
  END IF;
  IF v_ovr.status <> 'approved' THEN
    RAISE EXCEPTION 'override_not_approved (status=%)', v_ovr.status USING ERRCODE = '42501';
  END IF;
  IF v_ovr.consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'override_already_consumed' USING ERRCODE = '42501';
  END IF;
  IF v_ovr.organization_id <> p_organization_id THEN
    RAISE EXCEPTION 'override_org_mismatch' USING ERRCODE = '42501';
  END IF;
  IF p_business_id IS NOT NULL
     AND v_ovr.business_id IS NOT NULL
     AND v_ovr.business_id <> p_business_id THEN
    RAISE EXCEPTION 'override_business_mismatch' USING ERRCODE = '42501';
  END IF;
  IF v_ovr.override_type IS DISTINCT FROM p_action THEN
    RAISE EXCEPTION 'override_action_mismatch (expected %, got %)', p_action, v_ovr.override_type
      USING ERRCODE = '42501';
  END IF;
  IF p_shift_id IS NOT NULL
     AND v_ovr.shift_id IS NOT NULL
     AND v_ovr.shift_id <> p_shift_id THEN
    RAISE EXCEPTION 'override_shift_mismatch' USING ERRCODE = '42501';
  END IF;
  IF COALESCE(v_ovr.approved_at, now()) < now() - interval '15 minutes' THEN
    RAISE EXCEPTION 'override_expired' USING ERRCODE = '42501';
  END IF;

  IF coalesce(array_length(v_matrix.restricted_roles,1),0) > 0 THEN
    SELECT EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = v_ovr.manager_id
        AND ur.organization_id = p_organization_id
        AND ur.is_active = true
        AND ur.role::text = ANY (v_matrix.restricted_roles)
    ) INTO v_role_ok;
    IF NOT COALESCE(v_role_ok,false) THEN
      RAISE EXCEPTION 'override_role_not_allowed' USING ERRCODE = '42501';
    END IF;
  END IF;

  UPDATE public.pos_manager_overrides
     SET status          = 'consumed',
         consumed_at     = now(),
         consumed_table  = COALESCE(p_consumed_table, consumed_table),
         consumed_ref_id = COALESCE(p_consumed_ref_id, consumed_ref_id)
   WHERE id = p_override_id;

  RETURN p_override_id;
END $$;

GRANT EXECUTE ON FUNCTION public.assert_manager_override(text,numeric,uuid,uuid,uuid,uuid,text,uuid) TO authenticated;

-- ---------- 5. Refactor close_pos_shift to use the helper ----------
CREATE OR REPLACE FUNCTION public.close_pos_shift(
  p_shift_id              uuid,
  p_actual_cash           numeric,
  p_notes                 text DEFAULT NULL,
  p_blind_close           boolean DEFAULT false,
  p_manager_override_id   uuid DEFAULT NULL,
  p_denomination_counted  boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_shift          public.pos_shifts;
  v_gate           jsonb;
  v_expected       numeric := 0;
  v_variance       numeric := 0;
  v_require_denom  boolean := false;
  v_allow_blind    boolean := true;
  v_actual         numeric;
BEGIN
  SELECT * INTO v_shift FROM public.pos_shifts WHERE id = p_shift_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Shift not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_shift.status <> 'open' THEN
    RAISE EXCEPTION 'Shift is not open (status=%)', v_shift.status USING ERRCODE = 'check_violation';
  END IF;

  v_gate := public.can_close_pos_shift(p_shift_id);
  IF NOT (v_gate->>'ok')::boolean THEN
    UPDATE public.pos_shifts SET close_blocked_reasons = (v_gate->'reasons')
     WHERE id = p_shift_id;
    RAISE EXCEPTION 'Cannot close shift: %', v_gate->>'reasons'
      USING ERRCODE = 'check_violation', DETAIL = (v_gate->>'reasons');
  END IF;

  SELECT
    COALESCE(require_denomination_count, false),
    COALESCE(allow_blind_close, true)
  INTO v_require_denom, v_allow_blind
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

  SELECT COALESCE(expected_cash_computed, v_shift.expected_cash, 0)
    INTO v_expected
  FROM public.v_pos_cash_expected
  WHERE shift_id = p_shift_id;
  IF v_expected IS NULL THEN v_expected := COALESCE(v_shift.expected_cash, 0); END IF;

  v_actual   := CASE WHEN p_blind_close THEN v_expected ELSE p_actual_cash END;
  v_variance := v_actual - v_expected;

  IF NOT p_blind_close THEN
    PERFORM public.assert_manager_override(
      'shift_variance',
      abs(v_variance),
      v_shift.organization_id,
      v_shift.business_id,
      p_shift_id,
      p_manager_override_id,
      'pos_shifts',
      p_shift_id
    );
  END IF;

  -- Allow the no-client-status-flip trigger to permit this update
  PERFORM set_config('pos.allow_close', 'true', true);

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

  RETURN jsonb_build_object(
    'success', true,
    'shift_id', p_shift_id,
    'expected_cash', v_expected,
    'actual_cash', v_actual,
    'variance', v_variance,
    'journal_entry_id', (SELECT journal_entry_id FROM public.pos_shifts WHERE id = p_shift_id)
  );
END $$;

GRANT EXECUTE ON FUNCTION public.close_pos_shift(uuid,numeric,text,boolean,uuid,boolean) TO authenticated;

-- ---------- 6. force_close_pos_shift RPC ----------
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
  v_shift     public.pos_shifts;
  v_expected  numeric := 0;
  v_actual    numeric;
  v_variance  numeric;
BEGIN
  IF COALESCE(btrim(p_reason),'') = '' THEN
    RAISE EXCEPTION 'Reason is required for a force-close' USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_shift FROM public.pos_shifts WHERE id = p_shift_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Shift not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_shift.status <> 'open' THEN
    RAISE EXCEPTION 'Shift is not open (status=%)', v_shift.status USING ERRCODE = 'check_violation';
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
         notes                 = COALESCE(notes,'') ||
                                 E'\n[FORCE-CLOSE] ' || p_reason,
         updated_at            = now()
   WHERE id = p_shift_id;

  INSERT INTO public.admin_audit_log
    (admin_user_id, action_type, target_org_id, target_entity_type, target_entity_id, details)
  VALUES
    (auth.uid(), 'pos.shift.force_close', v_shift.organization_id, 'pos_shifts', p_shift_id::text,
     jsonb_build_object('reason', p_reason, 'override_id', p_override_id,
                        'expected', v_expected, 'actual', v_actual, 'variance', v_variance));

  RETURN jsonb_build_object(
    'success', true,
    'shift_id', p_shift_id,
    'expected_cash', v_expected,
    'actual_cash', v_actual,
    'variance', v_variance,
    'journal_entry_id', (SELECT journal_entry_id FROM public.pos_shifts WHERE id = p_shift_id)
  );
END $$;

GRANT EXECUTE ON FUNCTION public.force_close_pos_shift(uuid,text,uuid,numeric) TO authenticated;

-- ---------- 7. reopen_pos_shift RPC ----------
CREATE OR REPLACE FUNCTION public.reopen_pos_shift(
  p_shift_id    uuid,
  p_reason      text,
  p_override_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_shift     public.pos_shifts;
  v_je_id     uuid;
  v_reversal  uuid;
BEGIN
  IF COALESCE(btrim(p_reason),'') = '' THEN
    RAISE EXCEPTION 'Reason is required to reopen a shift' USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_shift FROM public.pos_shifts WHERE id = p_shift_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Shift not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_shift.status <> 'closed' THEN
    RAISE EXCEPTION 'Shift is not closed (status=%)', v_shift.status USING ERRCODE = 'check_violation';
  END IF;
  IF v_shift.closed_at IS NULL OR v_shift.closed_at < now() - interval '72 hours' THEN
    RAISE EXCEPTION 'Reopen window has elapsed (>72h since close)' USING ERRCODE = 'check_violation';
  END IF;

  PERFORM public.assert_manager_override(
    'reopen_shift',
    0,
    v_shift.organization_id,
    v_shift.business_id,
    p_shift_id,
    p_override_id,
    'pos_shifts',
    p_shift_id
  );

  v_je_id := v_shift.journal_entry_id;
  IF v_je_id IS NOT NULL THEN
    BEGIN
      v_reversal := public.void_journal_entry_atomic(
        v_je_id, 'POS shift reopen: ' || p_reason, auth.uid(), NULL, NULL);
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'Failed to reverse close journal entry: %', SQLERRM
        USING ERRCODE = 'check_violation';
    END;
  END IF;

  -- Allow the no-client-status-flip trigger to permit reopen flips too
  PERFORM set_config('pos.allow_close', 'true', true);

  UPDATE public.pos_shifts
     SET status            = 'open',
         closed_at         = NULL,
         closed_by         = NULL,
         actual_cash       = NULL,
         cash_difference   = NULL,
         journal_entry_id  = NULL,
         gl_posted_at      = NULL,
         reopened_at       = now(),
         reopened_by       = auth.uid(),
         reopen_reason     = p_reason,
         reopen_count      = COALESCE(reopen_count,0) + 1,
         updated_at        = now()
   WHERE id = p_shift_id;

  INSERT INTO public.admin_audit_log
    (admin_user_id, action_type, target_org_id, target_entity_type, target_entity_id, details)
  VALUES
    (auth.uid(), 'pos.shift.reopen', v_shift.organization_id, 'pos_shifts', p_shift_id::text,
     jsonb_build_object('reason', p_reason, 'override_id', p_override_id,
                        'reversed_journal_entry_id', v_reversal,
                        'original_journal_entry_id', v_je_id));

  RETURN jsonb_build_object(
    'success', true,
    'shift_id', p_shift_id,
    'reversed_journal_entry_id', v_reversal
  );
END $$;

GRANT EXECUTE ON FUNCTION public.reopen_pos_shift(uuid,text,uuid) TO authenticated;

-- ---------- 8. Trigger to forbid client-side status flips ----------
CREATE OR REPLACE FUNCTION public._pos_shifts_no_client_status_flip()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  -- Only enforce when status is changing to/from 'closed' (not for unrelated UPDATEs)
  IF (OLD.status = 'open'   AND NEW.status = 'closed')
  OR (OLD.status = 'closed' AND NEW.status = 'open') THEN
    IF current_setting('pos.allow_close', true) IS DISTINCT FROM 'true' THEN
      RAISE EXCEPTION 'pos_shifts.status can only be changed via close_pos_shift / force_close_pos_shift / reopen_pos_shift'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_pos_shifts_no_client_status_flip ON public.pos_shifts;
CREATE TRIGGER trg_pos_shifts_no_client_status_flip
  BEFORE UPDATE OF status ON public.pos_shifts
  FOR EACH ROW EXECUTE FUNCTION public._pos_shifts_no_client_status_flip();