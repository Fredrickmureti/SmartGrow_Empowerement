-- 1. Register the new unrealized FX roles, then their eligibility rows
INSERT INTO public.system_account_roles (role_key, label, description, category, required_account_type, is_mandatory, sort_order) VALUES
  ('fx_unrealized_gain', 'FX Unrealized Gain', 'Unrealized foreign-exchange gain from period-end revaluation', 'advanced', 'income',  false, 75),
  ('fx_unrealized_loss', 'FX Unrealized Loss', 'Unrealized foreign-exchange loss from period-end revaluation', 'advanced', 'expense', false, 76)
ON CONFLICT (role_key) DO NOTHING;

INSERT INTO public.account_role_eligibility (role_key, account_type, detail_type, priority) VALUES
  ('fx_unrealized_gain', 'income',  'other_income',        1),
  ('fx_unrealized_gain', 'income',  'other_misc_income',   2),
  ('fx_unrealized_gain', 'income',  'gain_on_investments', 3),
  ('fx_unrealized_loss', 'expense', 'exchange_gain_loss',  1),
  ('fx_unrealized_loss', 'expense', 'finance_costs',       2),
  ('fx_unrealized_loss', 'expense', 'other_expense',       3)
ON CONFLICT DO NOTHING;

-- 2. One resolution mechanism for every FX P&L account.
CREATE OR REPLACE FUNCTION public.resolve_fx_account(p_business_id uuid, p_purpose text)
RETURNS uuid
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_id uuid;
  v_org uuid;
  v_kind text;
BEGIN
  IF p_purpose NOT IN ('fx_realized_gain','fx_realized_loss','fx_unrealized_gain','fx_unrealized_loss') THEN
    RAISE EXCEPTION 'Unknown FX account purpose %', p_purpose;
  END IF;
  v_kind := CASE WHEN p_purpose LIKE '%gain' THEN 'gain' ELSE 'loss' END;

  -- (a) explicit mapping from Settings > Default Accounts
  SELECT account_id INTO v_id
    FROM public.default_account_settings
   WHERE business_id = p_business_id
     AND setting_key = p_purpose
     AND branch_id IS NULL
   LIMIT 1;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;

  -- (b) legacy purpose table
  SELECT account_id INTO v_id
    FROM public.default_accounts
   WHERE business_id = p_business_id
     AND purpose = p_purpose
     AND branch_id IS NULL
   LIMIT 1;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;

  -- (c) eligibility catalogue, then name heuristic — deterministic order
  SELECT organization_id INTO v_org FROM public.businesses WHERE id = p_business_id;

  SELECT a.id INTO v_id
    FROM public.accounts a
    JOIN public.account_role_eligibility e
      ON e.role_key = p_purpose
     AND e.account_type = a.account_type::text
     AND e.detail_type = a.detail_type::text
   WHERE a.business_id = p_business_id AND a.organization_id = v_org
     AND a.is_active = true AND COALESCE(a.is_header,false) = false
   ORDER BY e.priority, a.code
   LIMIT 1;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;

  SELECT a.id INTO v_id FROM public.accounts a
   WHERE a.business_id = p_business_id AND a.organization_id = v_org
     AND a.is_active = true AND COALESCE(a.is_header,false) = false
     AND a.account_type = CASE WHEN v_kind = 'gain' THEN 'income'::account_type ELSE 'expense'::account_type END
     AND (LOWER(a.name) LIKE '%exchange%' OR LOWER(a.name) LIKE '%forex%' OR LOWER(a.name) LIKE '%fx %')
   ORDER BY a.code
   LIMIT 1;

  IF v_id IS NULL THEN
    RAISE EXCEPTION 'No % account is configured. Map it under Settings > Default Accounts before running this operation.', replace(p_purpose,'_',' ')
      USING ERRCODE = '23514';
  END IF;
  RETURN v_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.resolve_fx_account(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_fx_account(uuid, text) TO authenticated, service_role;

-- realized lookup now delegates: one mechanism, no second heuristic
CREATE OR REPLACE FUNCTION public.resolve_fx_realized_account(p_business_id uuid, p_kind text)
RETURNS uuid
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF p_kind NOT IN ('gain','loss') THEN
    RAISE EXCEPTION 'Unknown FX account kind %', p_kind;
  END IF;
  RETURN public.resolve_fx_account(p_business_id, 'fx_realized_' || p_kind);
END;
$function$;

CREATE OR REPLACE FUNCTION public.resolve_fx_unrealized_account(p_business_id uuid, p_kind text)
RETURNS uuid
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF p_kind NOT IN ('gain','loss') THEN
    RAISE EXCEPTION 'Unknown FX account kind %', p_kind;
  END IF;
  RETURN public.resolve_fx_account(p_business_id, 'fx_unrealized_' || p_kind);
END;
$function$;

REVOKE ALL ON FUNCTION public.resolve_fx_unrealized_account(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_fx_unrealized_account(uuid, text) TO authenticated, service_role;

-- 3. revalue_fx_balances: base currency and FX accounts become server-derived.
DO $patch$
DECLARE
  _src text;
  _new text;
  _anchor text;
  _replacement text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO _src FROM pg_proc
   WHERE proname = 'revalue_fx_balances' AND pronamespace = 'public'::regnamespace;
  IF _src IS NULL THEN RAISE EXCEPTION 'revalue_fx_balances not found'; END IF;

  _anchor := '  SELECT business_id INTO _gain_business FROM public.accounts WHERE id = _unrealized_gain_account;
  SELECT business_id INTO _loss_business FROM public.accounts WHERE id = _unrealized_loss_account;
  IF _gain_business IS DISTINCT FROM _business_id OR _loss_business IS DISTINCT FROM _business_id THEN
    RAISE EXCEPTION ''FX gain/loss accounts must belong to the selected business'' USING ERRCODE = ''23514'';
  END IF;';

  IF position(_anchor in _src) = 0 THEN
    RAISE EXCEPTION 'revalue_fx_balances account-guard fragment did not match — refusing to patch blind';
  END IF;

  _replacement := '  -- The reporting currency is a property of the legal entity, never of the caller.
  SELECT upper(base_currency) INTO _entity_base FROM public.businesses WHERE id = _business_id;
  IF _entity_base IS NULL THEN
    RAISE EXCEPTION ''Business % has no base currency configured'', _business_id USING ERRCODE = ''23514'';
  END IF;
  IF _base_currency IS NOT NULL AND upper(_base_currency) <> _entity_base THEN
    RAISE EXCEPTION ''Base currency % does not match this company''''s books (%)'', upper(_base_currency), _entity_base
      USING ERRCODE = ''23514'';
  END IF;
  _base_currency := _entity_base;

  -- FX result accounts come from the central mapping, not from the caller.
  _resolved_gain := public.resolve_fx_unrealized_account(_business_id, ''gain'');
  _resolved_loss := public.resolve_fx_unrealized_account(_business_id, ''loss'');
  IF _unrealized_gain_account IS NOT NULL AND _unrealized_gain_account <> _resolved_gain THEN
    RAISE EXCEPTION ''Unrealized FX gain account is set in Default Accounts and cannot be overridden per run''
      USING ERRCODE = ''23514'';
  END IF;
  IF _unrealized_loss_account IS NOT NULL AND _unrealized_loss_account <> _resolved_loss THEN
    RAISE EXCEPTION ''Unrealized FX loss account is set in Default Accounts and cannot be overridden per run''
      USING ERRCODE = ''23514'';
  END IF;
  _unrealized_gain_account := _resolved_gain;
  _unrealized_loss_account := _resolved_loss;

  SELECT business_id INTO _gain_business FROM public.accounts WHERE id = _unrealized_gain_account;
  SELECT business_id INTO _loss_business FROM public.accounts WHERE id = _unrealized_loss_account;
  IF _gain_business IS DISTINCT FROM _business_id OR _loss_business IS DISTINCT FROM _business_id THEN
    RAISE EXCEPTION ''FX gain/loss accounts must belong to the selected business'' USING ERRCODE = ''23514'';
  END IF;';

  _new := replace(_src, _anchor, _replacement);

  -- declare the new locals
  IF position('  _uid uuid := COALESCE(auth.uid(), _user_id);' in _new) = 0 THEN
    RAISE EXCEPTION 'revalue_fx_balances declaration anchor did not match';
  END IF;
  _new := replace(_new,
    '  _uid uuid := COALESCE(auth.uid(), _user_id);',
    '  _uid uuid := COALESCE(auth.uid(), _user_id);
  _entity_base text;
  _resolved_gain uuid;
  _resolved_loss uuid;');

  -- accounts are optional now
  _new := replace(_new,
    '_unrealized_gain_account uuid, _unrealized_loss_account uuid, _user_id uuid DEFAULT NULL::uuid',
    '_unrealized_gain_account uuid DEFAULT NULL::uuid, _unrealized_loss_account uuid DEFAULT NULL::uuid, _user_id uuid DEFAULT NULL::uuid');
  _new := replace(_new, '_base_currency text,', '_base_currency text DEFAULT NULL::text,');

  EXECUTE _new;
END
$patch$;
