-- Fix: upsert_pos_security_settings referenced phantom public.user_organizations.
-- Canonical membership table is public.user_roles (May 17 audit). Match the
-- predicate already used by tg_assert_pos_payment_method_scope /
-- tg_assert_pos_scope_caller_access. No schema/signature change.

CREATE OR REPLACE FUNCTION public.upsert_pos_security_settings(
  p_business_id uuid,
  p_branch_id uuid,
  p_updates jsonb
)
RETURNS public.pos_security_settings
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_org_id uuid;
  v_before public.pos_security_settings;
  v_after public.pos_security_settings;
  v_uid uuid := auth.uid();
  v_is_admin boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '42501';
  END IF;

  SELECT organization_id INTO v_org_id
  FROM public.businesses WHERE id = p_business_id;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'business_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- Membership/role check via canonical public.user_roles (NOT user_organizations).
  -- Company-shared settings: require org admin. Per-branch override: allow
  -- branch-access holders too (matches the trigger guard semantics).
  IF p_branch_id IS NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = v_uid
        AND ur.organization_id = v_org_id
        AND ur.is_active = true
        AND ur.role IN ('owner','admin','super_admin')
    ) INTO v_is_admin;
    IF NOT COALESCE(v_is_admin, false) THEN
      RAISE EXCEPTION 'forbidden: org admin required for company-default POS security settings'
        USING ERRCODE = '42501';
    END IF;
  ELSE
    IF NOT EXISTS (
      SELECT 1 FROM public.branches
      WHERE id = p_branch_id AND business_id = p_business_id
    ) THEN
      RAISE EXCEPTION 'branch_business_mismatch' USING ERRCODE = '22023';
    END IF;
    IF NOT public.user_can_access_branch(v_uid, p_branch_id) THEN
      RAISE EXCEPTION 'forbidden: no access to branch %', p_branch_id
        USING ERRCODE = '42501';
    END IF;
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
$function$;

GRANT EXECUTE ON FUNCTION public.upsert_pos_security_settings(uuid, uuid, jsonb) TO authenticated;

NOTIFY pgrst, 'reload schema';