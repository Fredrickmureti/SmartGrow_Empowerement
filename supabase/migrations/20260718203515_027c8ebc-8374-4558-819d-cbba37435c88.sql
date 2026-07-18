
ALTER TABLE public.pos_payment_methods
  ADD COLUMN IF NOT EXISTS tender_kind text NOT NULL DEFAULT 'other',
  ADD COLUMN IF NOT EXISTS capture_mode text NOT NULL DEFAULT 'immediate',
  ADD COLUMN IF NOT EXISTS requires_terminal boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS provider_key text,
  ADD COLUMN IF NOT EXISTS settlement_gl_account_id uuid REFERENCES public.accounts(id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pos_payment_methods_tender_kind_chk'
  ) THEN
    ALTER TABLE public.pos_payment_methods
      ADD CONSTRAINT pos_payment_methods_tender_kind_chk
      CHECK (tender_kind IN ('cash','card','wallet','voucher','credit_liability','ar_credit','bank','other'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pos_payment_methods_capture_mode_chk'
  ) THEN
    ALTER TABLE public.pos_payment_methods
      ADD CONSTRAINT pos_payment_methods_capture_mode_chk
      CHECK (capture_mode IN ('immediate','two_step','external_lookup','deferred'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_pos_payment_methods_tender_kind
  ON public.pos_payment_methods (tender_kind);
CREATE INDEX IF NOT EXISTS idx_pos_payment_methods_provider_key
  ON public.pos_payment_methods (provider_key) WHERE provider_key IS NOT NULL;

UPDATE public.pos_payment_methods SET
  tender_kind='cash', capture_mode='immediate', requires_terminal=false
WHERE method_key='cash';

UPDATE public.pos_payment_methods SET
  tender_kind='card', capture_mode='two_step', requires_terminal=true
WHERE method_key='card';

UPDATE public.pos_payment_methods SET
  tender_kind='wallet', capture_mode='external_lookup', requires_terminal=false,
  provider_key=COALESCE(provider_key,'mpesa')
WHERE method_key='mobile_money';

UPDATE public.pos_payment_methods SET
  tender_kind='bank', capture_mode='external_lookup', requires_terminal=false
WHERE method_key='bank_transfer';

UPDATE public.pos_payment_methods SET
  tender_kind='voucher', capture_mode='immediate', requires_terminal=false
WHERE method_key='voucher';

UPDATE public.pos_payment_methods SET
  tender_kind='credit_liability', capture_mode='deferred', requires_terminal=false
WHERE method_key='credit';

COMMENT ON COLUMN public.pos_payment_methods.tender_kind IS
  'Enterprise tender family. Drives GL routing, receipt phrasing, and client tender-panel selection. See docs/architecture/POS_CHECKOUT_ENGINE.md.';
COMMENT ON COLUMN public.pos_payment_methods.capture_mode IS
  'Lifecycle of money movement: immediate | two_step (auth/capture) | external_lookup (gateway) | deferred (A/R).';
COMMENT ON COLUMN public.pos_payment_methods.requires_terminal IS
  'True when a hardware terminal (EMV, wallet reader) must authorize the tender.';
COMMENT ON COLUMN public.pos_payment_methods.provider_key IS
  'External provider binding (mpesa, stripe, adyen, etc). Nullable.';

ALTER TABLE public.pos_transaction_payments
  ADD COLUMN IF NOT EXISTS auth_state text,
  ADD COLUMN IF NOT EXISTS auth_id text,
  ADD COLUMN IF NOT EXISTS authorized_amount numeric,
  ADD COLUMN IF NOT EXISTS vendor_txn_id text,
  ADD COLUMN IF NOT EXISTS capture_mode_used text,
  ADD COLUMN IF NOT EXISTS tender_kind text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pos_transaction_payments_auth_state_chk'
  ) THEN
    ALTER TABLE public.pos_transaction_payments
      ADD CONSTRAINT pos_transaction_payments_auth_state_chk
      CHECK (auth_state IS NULL OR auth_state IN
        ('idle','collecting','authorizing','approved','declined','captured','voided','refunded','failed'));
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.pos_validate_payment_line(
  _business_id uuid,
  _method_key text,
  _payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_method     public.pos_payment_methods%ROWTYPE;
  v_amount     numeric;
  v_tendered   numeric;
  v_reference  text;
BEGIN
  IF _method_key IS NULL OR btrim(_method_key) = '' THEN
    RAISE EXCEPTION 'pos_validate_payment_line: method_key is required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT * INTO v_method
    FROM public.pos_payment_methods
   WHERE method_key = _method_key
     AND (business_id = _business_id OR business_id IS NULL)
   ORDER BY (business_id = _business_id) DESC NULLS LAST
   LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'pos_validate_payment_line: unknown payment method %', _method_key
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF NOT v_method.is_enabled THEN
    RAISE EXCEPTION 'pos_validate_payment_line: payment method % is disabled', _method_key
      USING ERRCODE = 'check_violation';
  END IF;

  v_amount    := COALESCE((_payload->>'amount')::numeric, 0);
  v_tendered  := COALESCE((_payload->>'tendered_amount')::numeric, v_amount);
  v_reference := NULLIF(btrim(COALESCE(_payload->>'reference','')), '');

  IF v_amount <= 0 THEN
    RAISE EXCEPTION 'pos_validate_payment_line: amount must be > 0 for %', _method_key
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_tendered < v_amount AND v_method.tender_kind <> 'cash' THEN
    RAISE EXCEPTION 'pos_validate_payment_line: tendered_amount (%) < amount (%) for non-cash tender %',
      v_tendered, v_amount, _method_key
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_method.requires_reference AND v_reference IS NULL THEN
    IF NULLIF(_payload->>'mpesa_receipt_number','') IS NULL
       AND NULLIF(_payload->>'vendor_txn_id','') IS NULL THEN
      RAISE EXCEPTION 'pos_validate_payment_line: reference required for %', _method_key
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF v_method.requires_terminal AND v_method.capture_mode = 'two_step' THEN
    IF NULLIF(_payload->>'auth_id','') IS NULL
       AND NULLIF(_payload->>'vendor_txn_id','') IS NULL THEN
      RAISE WARNING 'pos_validate_payment_line: terminal tender % missing auth_id (Phase C will reject)', _method_key;
    END IF;
  END IF;

  IF v_method.provider_key IS NOT NULL
     AND NULLIF(_payload->>'provider_key','') IS NOT NULL
     AND _payload->>'provider_key' <> v_method.provider_key THEN
    RAISE EXCEPTION 'pos_validate_payment_line: provider mismatch (% vs %)',
      _payload->>'provider_key', v_method.provider_key
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN jsonb_build_object(
    'method_key',        v_method.method_key,
    'tender_kind',       v_method.tender_kind,
    'capture_mode',      v_method.capture_mode,
    'requires_terminal', v_method.requires_terminal,
    'provider_key',      v_method.provider_key,
    'settlement_gl_account_id', v_method.settlement_gl_account_id
  );
END $$;

REVOKE ALL ON FUNCTION public.pos_validate_payment_line(uuid, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pos_validate_payment_line(uuid, text, jsonb) TO authenticated, service_role;

COMMENT ON FUNCTION public.pos_validate_payment_line(uuid, text, jsonb) IS
  'Phase B (Wave 2): catalog-driven validation for a payment line payload. Called by _pos_record_payment inside the sale transaction so invalid tenders roll back atomically.';

CREATE OR REPLACE FUNCTION public._pos_record_payment(
  _txn_id uuid, _org_id uuid, _biz_id uuid, _branch_id uuid, _payload jsonb
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_id uuid;
  v_method text;
  v_amount numeric;
  v_tendered numeric;
  v_change numeric;
  v_meta jsonb;
BEGIN
  IF _txn_id IS NULL OR _payload IS NULL THEN
    RAISE EXCEPTION '_pos_record_payment: _txn_id and _payload are required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  v_method   := _payload->>'payment_method';
  v_amount   := COALESCE((_payload->>'amount')::numeric, 0);
  v_tendered := COALESCE((_payload->>'tendered_amount')::numeric, v_amount);
  v_change   := COALESCE((_payload->>'change_given')::numeric, GREATEST(0, v_tendered - v_amount));

  v_meta := public.pos_validate_payment_line(_biz_id, v_method, _payload);

  INSERT INTO public.pos_transaction_payments (
    transaction_id, organization_id, business_id, branch_id,
    payment_method, amount, tendered_amount, change_given,
    reference, card_last_four, card_type, mpesa_receipt_number,
    status, processed_at,
    tender_kind, capture_mode_used,
    auth_state, auth_id, authorized_amount, vendor_txn_id
  ) VALUES (
    _txn_id, _org_id, _biz_id, _branch_id,
    v_method, v_amount, v_tendered, v_change,
    _payload->>'reference', _payload->>'card_last_four',
    _payload->>'card_type', _payload->>'mpesa_receipt_number',
    COALESCE(_payload->>'status','completed'), now(),
    v_meta->>'tender_kind', v_meta->>'capture_mode',
    NULLIF(_payload->>'auth_state',''),
    NULLIF(_payload->>'auth_id',''),
    NULLIF(_payload->>'authorized_amount','')::numeric,
    NULLIF(_payload->>'vendor_txn_id','')
  ) RETURNING id INTO v_id;

  RETURN v_id;
END $$;

REVOKE ALL ON FUNCTION public._pos_record_payment(uuid, uuid, uuid, uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._pos_record_payment(uuid, uuid, uuid, uuid, jsonb) TO authenticated, service_role;
