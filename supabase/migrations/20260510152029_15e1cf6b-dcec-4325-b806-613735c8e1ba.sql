
-- Drop both existing overloads of pos_apply_default_method_gl
DROP FUNCTION IF EXISTS public.pos_apply_default_method_gl(uuid);
DROP FUNCTION IF EXISTS public.pos_apply_default_method_gl(uuid, uuid);

-- Recreate single resolver: maps to debit_account_id (the column the CHECK enforces),
-- works regardless of is_enabled, optional method-key filter.
CREATE OR REPLACE FUNCTION public.pos_apply_default_method_gl(
  _business_id uuid,
  _method_keys text[] DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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
BEGIN
  IF _business_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'business_id_required');
  END IF;

  SELECT organization_id INTO v_org_id FROM public.businesses WHERE id = _business_id;
  IF v_org_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'business_not_found');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = auth.uid()
      AND ur.organization_id = v_org_id
      AND ur.is_active = true
      AND ur.role::text IN ('owner','admin','accountant','platform_admin')
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;

  v_cash_acct := COALESCE(
    public.get_default_account_id(v_org_id, _business_id, 'pos_cash'),
    public.get_default_account_id(v_org_id, _business_id, 'cash')
  );
  v_bank_acct := public.get_default_account_id(v_org_id, _business_id, 'bank');
  v_clearing_acct := COALESCE(
    public.get_default_account_id(v_org_id, _business_id, 'pos_clearing'),
    public.get_default_account_id(v_org_id, _business_id, 'undeposited_funds'),
    v_bank_acct
  );
  v_card_acct := COALESCE(
    public.get_default_account_id(v_org_id, _business_id, 'card_clearing'),
    v_clearing_acct
  );

  FOR r IN
    SELECT id, method_key, display_name, debit_account_id
    FROM public.pos_payment_methods
    WHERE business_id = _business_id
      AND debit_account_id IS NULL
      AND (_method_keys IS NULL OR method_key = ANY(_method_keys))
  LOOP
    v_target := NULL;

    IF r.method_key = 'cash' THEN
      v_target := v_cash_acct;
    ELSIF r.method_key IN ('card','credit_card','debit_card') THEN
      v_target := v_card_acct;
    ELSIF r.method_key IN ('mobile_money','mpesa') THEN
      v_target := v_clearing_acct;
    ELSIF r.method_key IN ('bank_transfer','bank') THEN
      v_target := COALESCE(v_bank_acct, v_clearing_acct);
    ELSIF r.method_key IN ('voucher','check','credit') THEN
      v_target := v_clearing_acct;
    ELSE
      v_target := v_clearing_acct;
    END IF;

    IF v_target IS NOT NULL THEN
      UPDATE public.pos_payment_methods
      SET debit_account_id = v_target, updated_at = now()
      WHERE id = r.id;
      v_updated := v_updated + 1;
      v_details := v_details || jsonb_build_object(
        'method_key', r.method_key,
        'display_name', r.display_name,
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
$function$;

-- Idempotent seeder for the six template methods, all disabled (CHECK-safe).
CREATE OR REPLACE FUNCTION public.seed_pos_payment_methods(_business_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_org_id uuid;
BEGIN
  IF _business_id IS NULL THEN
    RETURN;
  END IF;

  SELECT organization_id INTO v_org_id FROM public.businesses WHERE id = _business_id;
  IF v_org_id IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO public.pos_payment_methods
    (organization_id, business_id, method_key, display_name, is_enabled, requires_reference, icon, sort_order, debit_account_id, branch_id)
  VALUES
    (v_org_id, _business_id, 'cash',          'Cash',           false, false, 'Banknote',   1, NULL, NULL),
    (v_org_id, _business_id, 'card',          'Card',           false, true,  'CreditCard', 2, NULL, NULL),
    (v_org_id, _business_id, 'mobile_money',  'Mobile Money',   false, true,  'Smartphone', 3, NULL, NULL),
    (v_org_id, _business_id, 'bank_transfer', 'Bank Transfer',  false, true,  'Building',   4, NULL, NULL),
    (v_org_id, _business_id, 'voucher',       'Check/Voucher',  false, true,  'FileText',   5, NULL, NULL),
    (v_org_id, _business_id, 'credit',        'Store Credit',   false, false, 'Wallet',     6, NULL, NULL)
  ON CONFLICT (business_id, method_key) DO NOTHING;
END;
$function$;

-- Trigger: seed payment methods on new business creation.
CREATE OR REPLACE FUNCTION public.trg_seed_pos_payment_methods_fn()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public.seed_pos_payment_methods(NEW.id);
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_seed_pos_payment_methods ON public.businesses;
CREATE TRIGGER trg_seed_pos_payment_methods
  AFTER INSERT ON public.businesses
  FOR EACH ROW EXECUTE FUNCTION public.trg_seed_pos_payment_methods_fn();

-- Backfill: seed for every existing business that has zero rows.
DO $$
DECLARE
  b record;
BEGIN
  FOR b IN
    SELECT id FROM public.businesses
    WHERE NOT EXISTS (SELECT 1 FROM public.pos_payment_methods ppm WHERE ppm.business_id = businesses.id)
  LOOP
    PERFORM public.seed_pos_payment_methods(b.id);
  END LOOP;
END $$;
