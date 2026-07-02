-- Fix legacy unique constraint on pos_security_settings to match
-- the (organization_id, business_id, branch_id) scoping model used by
-- resolve_pos_security_settings and the branch-override editor.

ALTER TABLE public.pos_security_settings
  DROP CONSTRAINT IF EXISTS pos_security_settings_organization_id_key;

-- Company-default row: exactly one per (org, business) when branch_id IS NULL.
CREATE UNIQUE INDEX IF NOT EXISTS uq_pos_security_settings_company_default
  ON public.pos_security_settings (organization_id, business_id)
  WHERE branch_id IS NULL;

-- Branch override: exactly one per (org, business, branch).
CREATE UNIQUE INDEX IF NOT EXISTS uq_pos_security_settings_branch_override
  ON public.pos_security_settings (organization_id, business_id, branch_id)
  WHERE branch_id IS NOT NULL;

-- Single mutation path for POS security settings. RLS is enforced by the
-- existing table policies; SECURITY DEFINER lets the RPC perform the
-- conflict-target-correct upsert and emit an audit_logs entry atomically.
CREATE OR REPLACE FUNCTION public.upsert_pos_security_settings(
  p_business_id uuid,
  p_branch_id uuid,
  p_updates jsonb
)
RETURNS public.pos_security_settings
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_id uuid;
  v_before public.pos_security_settings;
  v_after public.pos_security_settings;
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '42501';
  END IF;

  SELECT organization_id INTO v_org_id
  FROM public.businesses WHERE id = p_business_id;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'business_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- Membership check: caller must belong to the org.
  IF NOT EXISTS (
    SELECT 1 FROM public.user_organizations
    WHERE user_id = v_uid AND organization_id = v_org_id
  ) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  -- If editing a branch override, verify the branch belongs to this business.
  IF p_branch_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.branches
    WHERE id = p_branch_id AND business_id = p_business_id
  ) THEN
    RAISE EXCEPTION 'branch_business_mismatch' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_before
  FROM public.pos_security_settings
  WHERE business_id = p_business_id
    AND ((p_branch_id IS NULL AND branch_id IS NULL)
      OR (p_branch_id IS NOT NULL AND branch_id = p_branch_id));

  IF v_before.id IS NULL THEN
    INSERT INTO public.pos_security_settings (
      organization_id, business_id, branch_id,
      require_cashier_pin, pin_length, session_timeout_minutes,
      lock_after_inactivity_minutes, require_manager_pin_for_price_override,
      require_manager_pin_for_drawer_open, void_limit_requires_approval,
      allow_offline_transactions, max_offline_transaction_amount,
      require_denomination_count, allow_blind_close
    )
    VALUES (
      v_org_id, p_business_id, p_branch_id,
      COALESCE((p_updates->>'require_cashier_pin')::boolean, true),
      COALESCE((p_updates->>'pin_length')::int, 4),
      COALESCE((p_updates->>'session_timeout_minutes')::int, 30),
      COALESCE((p_updates->>'lock_after_inactivity_minutes')::int, 5),
      COALESCE((p_updates->>'require_manager_pin_for_price_override')::boolean, true),
      COALESCE((p_updates->>'require_manager_pin_for_drawer_open')::boolean, false),
      COALESCE((p_updates->>'void_limit_requires_approval')::numeric, 0),
      COALESCE((p_updates->>'allow_offline_transactions')::boolean, true),
      COALESCE((p_updates->>'max_offline_transaction_amount')::numeric, 10000),
      COALESCE((p_updates->>'require_denomination_count')::boolean, false),
      COALESCE((p_updates->>'allow_blind_close')::boolean, false)
    )
    RETURNING * INTO v_after;
  ELSE
    UPDATE public.pos_security_settings SET
      require_cashier_pin = COALESCE((p_updates->>'require_cashier_pin')::boolean, require_cashier_pin),
      pin_length = COALESCE((p_updates->>'pin_length')::int, pin_length),
      session_timeout_minutes = COALESCE((p_updates->>'session_timeout_minutes')::int, session_timeout_minutes),
      lock_after_inactivity_minutes = COALESCE((p_updates->>'lock_after_inactivity_minutes')::int, lock_after_inactivity_minutes),
      require_manager_pin_for_price_override = COALESCE((p_updates->>'require_manager_pin_for_price_override')::boolean, require_manager_pin_for_price_override),
      require_manager_pin_for_drawer_open = COALESCE((p_updates->>'require_manager_pin_for_drawer_open')::boolean, require_manager_pin_for_drawer_open),
      void_limit_requires_approval = COALESCE((p_updates->>'void_limit_requires_approval')::numeric, void_limit_requires_approval),
      allow_offline_transactions = COALESCE((p_updates->>'allow_offline_transactions')::boolean, allow_offline_transactions),
      max_offline_transaction_amount = COALESCE((p_updates->>'max_offline_transaction_amount')::numeric, max_offline_transaction_amount),
      require_denomination_count = COALESCE((p_updates->>'require_denomination_count')::boolean, require_denomination_count),
      allow_blind_close = COALESCE((p_updates->>'allow_blind_close')::boolean, allow_blind_close),
      updated_at = now()
    WHERE id = v_before.id
    RETURNING * INTO v_after;
  END IF;

  -- Best-effort audit log; do not fail the mutation if audit insert fails.
  BEGIN
    INSERT INTO public.audit_logs (
      organization_id, business_id, user_id, action, entity_type, entity_id,
      before_state, after_state
    ) VALUES (
      v_org_id, p_business_id, v_uid,
      CASE WHEN v_before.id IS NULL THEN 'create' ELSE 'update' END,
      'pos_security_settings', v_after.id,
      to_jsonb(v_before), to_jsonb(v_after)
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN v_after;
END;
$$;

GRANT EXECUTE ON FUNCTION public.upsert_pos_security_settings(uuid, uuid, jsonb) TO authenticated;

-- Safe shift opener — wraps the precheck + insert in a single transaction
-- and emits a structured exception when an existing open shift blocks it,
-- so the client can render a branch-aware actionable error.
CREATE OR REPLACE FUNCTION public.open_pos_shift_safe(
  p_register_id uuid,
  p_opening_cash numeric,
  p_notes text DEFAULT NULL
)
RETURNS public.pos_shifts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_register record;
  v_existing record;
  v_shift_number text;
  v_result public.pos_shifts;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '42501';
  END IF;

  SELECT id, organization_id, business_id, branch_id
    INTO v_register
  FROM public.pos_registers WHERE id = p_register_id;
  IF v_register.id IS NULL THEN
    RAISE EXCEPTION 'register_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_register.branch_id IS NULL THEN
    RAISE EXCEPTION 'register_missing_branch' USING ERRCODE = '22023';
  END IF;

  -- Detect ANY existing open shift for this user across branches so we can
  -- report the offending branch instead of letting the partial unique index
  -- raise a generic 23505.
  SELECT s.id, s.shift_number, s.branch_id, s.register_id, b.name AS branch_name
    INTO v_existing
  FROM public.pos_shifts s
  LEFT JOIN public.branches b ON b.id = s.branch_id
  WHERE s.user_id = v_uid AND s.status = 'open'
  LIMIT 1;

  IF v_existing.id IS NOT NULL THEN
    RAISE EXCEPTION 'open_shift_exists'
      USING ERRCODE = '23505',
            DETAIL = jsonb_build_object(
              'shift_id', v_existing.id,
              'shift_number', v_existing.shift_number,
              'branch_id', v_existing.branch_id,
              'branch_name', v_existing.branch_name,
              'register_id', v_existing.register_id
            )::text;
  END IF;

  -- Check the register-level partial unique (could be another cashier).
  SELECT id INTO v_existing
  FROM public.pos_shifts
  WHERE register_id = p_register_id AND status = 'open'
  LIMIT 1;
  IF v_existing.id IS NOT NULL THEN
    RAISE EXCEPTION 'register_shift_in_progress'
      USING ERRCODE = '23505',
            DETAIL = jsonb_build_object('shift_id', v_existing.id)::text;
  END IF;

  SELECT public.get_next_shift_number(v_register.organization_id, p_register_id)
    INTO v_shift_number;

  INSERT INTO public.pos_shifts (
    organization_id, business_id, branch_id, register_id, user_id,
    shift_number, opening_cash, expected_cash, notes, status
  ) VALUES (
    v_register.organization_id, v_register.business_id, v_register.branch_id,
    p_register_id, v_uid, v_shift_number, p_opening_cash, p_opening_cash,
    p_notes, 'open'
  )
  RETURNING * INTO v_result;

  UPDATE public.pos_registers
     SET last_active_at = now()
   WHERE id = p_register_id;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.open_pos_shift_safe(uuid, numeric, text) TO authenticated;