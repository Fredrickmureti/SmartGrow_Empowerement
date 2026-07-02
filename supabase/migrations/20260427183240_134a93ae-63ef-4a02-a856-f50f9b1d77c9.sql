
CREATE OR REPLACE FUNCTION public.pos_apply_default_method_gl(_business_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_id        uuid;
  v_cash_acct     uuid;
  v_bank_acct     uuid;
  v_clearing_acct uuid;
  v_card_acct     uuid;
  v_updated       int := 0;
  v_skipped       int := 0;
  v_details       jsonb := '[]'::jsonb;
  r               record;
  v_target        uuid;
  v_field         text;
BEGIN
  IF _business_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'business_id_required');
  END IF;

  SELECT organization_id INTO v_org_id FROM public.businesses WHERE id = _business_id;
  IF v_org_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'business_not_found');
  END IF;

  -- Authorization: must be a member of the org with a privileged role.
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = auth.uid()
      AND ur.organization_id = v_org_id
      AND ur.is_active = true
      AND ur.role::text IN ('owner','admin','accountant','platform_admin')
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;

  v_cash_acct     := COALESCE(
    public.get_default_account_id(v_org_id, _business_id, 'pos_cash'),
    public.get_default_account_id(v_org_id, _business_id, 'cash')
  );
  v_bank_acct     := public.get_default_account_id(v_org_id, _business_id, 'bank');
  v_clearing_acct := COALESCE(
    public.get_default_account_id(v_org_id, _business_id, 'pos_clearing'),
    public.get_default_account_id(v_org_id, _business_id, 'undeposited_funds')
  );
  v_card_acct     := COALESCE(
    public.get_default_account_id(v_org_id, _business_id, 'card_clearing'),
    v_clearing_acct,
    v_bank_acct
  );

  FOR r IN
    SELECT id, method_key, display_name, debit_account_id, clearing_account_id
    FROM public.pos_payment_methods
    WHERE business_id = _business_id
      AND COALESCE(is_enabled, true) = true
      AND debit_account_id IS NULL
      AND clearing_account_id IS NULL
  LOOP
    v_target := NULL;
    v_field  := NULL;

    -- Heuristics: cash -> debit cash; card/mobile/bank/check -> clearing
    IF r.method_key = 'cash' AND v_cash_acct IS NOT NULL THEN
      v_target := v_cash_acct;
      v_field  := 'debit_account_id';
    ELSIF r.method_key IN ('card','credit_card','debit_card') AND v_card_acct IS NOT NULL THEN
      v_target := v_card_acct;
      v_field  := 'clearing_account_id';
    ELSIF r.method_key IN ('mobile_money','mpesa') AND v_clearing_acct IS NOT NULL THEN
      v_target := v_clearing_acct;
      v_field  := 'clearing_account_id';
    ELSIF r.method_key IN ('bank_transfer','bank') AND COALESCE(v_bank_acct, v_clearing_acct) IS NOT NULL THEN
      v_target := COALESCE(v_bank_acct, v_clearing_acct);
      v_field  := 'clearing_account_id';
    ELSIF r.method_key IN ('voucher','check','credit') AND v_clearing_acct IS NOT NULL THEN
      v_target := v_clearing_acct;
      v_field  := 'clearing_account_id';
    END IF;

    IF v_target IS NOT NULL THEN
      IF v_field = 'debit_account_id' THEN
        UPDATE public.pos_payment_methods
        SET debit_account_id = v_target, updated_at = now()
        WHERE id = r.id;
      ELSE
        UPDATE public.pos_payment_methods
        SET clearing_account_id = v_target, updated_at = now()
        WHERE id = r.id;
      END IF;
      v_updated := v_updated + 1;
      v_details := v_details || jsonb_build_object(
        'method_key', r.method_key,
        'display_name', r.display_name,
        'field', v_field,
        'account_id', v_target,
        'status', 'mapped'
      );
    ELSE
      v_skipped := v_skipped + 1;
      v_details := v_details || jsonb_build_object(
        'method_key', r.method_key,
        'display_name', r.display_name,
        'status', 'skipped_no_default'
      );
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'updated', v_updated,
    'skipped', v_skipped,
    'details', v_details
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.pos_apply_default_method_gl(uuid) TO authenticated;
