-- D4: supplier payments on account.
-- 1. bill_payments learns its vendor, so an unapplied advance is a real,
--    queryable AP document rather than an orphan row.
ALTER TABLE public.bill_payments
  ADD COLUMN IF NOT EXISTS vendor_id uuid REFERENCES public.contacts(id);

UPDATE public.bill_payments bp
   SET vendor_id = sub.vendor_id
  FROM (
    SELECT DISTINCT ON (a.bill_payment_id) a.bill_payment_id, b.vendor_id
      FROM public.bill_payment_allocations a
      JOIN public.bills b ON b.id = a.bill_id
     WHERE b.vendor_id IS NOT NULL
  ) sub
 WHERE bp.id = sub.bill_payment_id
   AND bp.vendor_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_bill_payments_vendor
  ON public.bill_payments (business_id, vendor_id, payment_date DESC);

-- 2. Allocation consistency now also owns the vendor stamp: allocating to a bill
--    fixes the payment's vendor, and cross-vendor allocation is rejected.
CREATE OR REPLACE FUNCTION public.check_bill_payment_allocation_consistency()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  bp_business uuid; bp_org uuid; bp_branch uuid; bp_vendor uuid;
  bl_vendor uuid; bl_business uuid; bl_org uuid;
  bp_existing_vendor uuid;
BEGIN
  SELECT bp.organization_id, bp.business_id, bp.branch_id, bp.vendor_id
    INTO bp_org, bp_business, bp_branch, bp_vendor
    FROM public.bill_payments bp
    WHERE bp.id = NEW.bill_payment_id;

  SELECT vendor_id, business_id, organization_id
    INTO bl_vendor, bl_business, bl_org
    FROM public.bills WHERE id = NEW.bill_id;

  IF bl_org IS DISTINCT FROM bp_org THEN
    RAISE EXCEPTION 'Bill payment allocation rejected: bill and payment belong to different workspaces.'
      USING ERRCODE = '23514';
  END IF;
  IF bl_business IS DISTINCT FROM bp_business THEN
    RAISE EXCEPTION 'Bill payment allocation rejected: bill and payment belong to different companies.'
      USING ERRCODE = '23514';
  END IF;

  -- All allocations on a single payment must point at bills of the same vendor.
  SELECT b2.vendor_id INTO bp_existing_vendor
    FROM public.bill_payment_allocations bpa2
    JOIN public.bills b2 ON b2.id = bpa2.bill_id
   WHERE bpa2.bill_payment_id = NEW.bill_payment_id
     AND bpa2.id IS DISTINCT FROM NEW.id
   LIMIT 1;
  IF bp_existing_vendor IS NOT NULL AND bp_existing_vendor IS DISTINCT FROM bl_vendor THEN
    RAISE EXCEPTION 'Bill payment allocation rejected: all allocations on a payment must share one vendor.'
      USING ERRCODE = '23514';
  END IF;

  -- An advance carries its vendor on the header; applying it elsewhere is a bug.
  IF bp_vendor IS NOT NULL AND bl_vendor IS NOT NULL AND bp_vendor IS DISTINCT FROM bl_vendor THEN
    RAISE EXCEPTION 'Bill payment allocation rejected: the payment belongs to a different supplier.'
      USING ERRCODE = '23514';
  END IF;
  IF bp_vendor IS NULL AND bl_vendor IS NOT NULL THEN
    UPDATE public.bill_payments SET vendor_id = bl_vendor WHERE id = NEW.bill_payment_id;
  END IF;

  NEW.organization_id := bp_org;
  NEW.business_id     := bp_business;
  NEW.branch_id       := COALESCE(NEW.branch_id, bp_branch);
  RETURN NEW;
END;
$function$;

-- 3. Vendor advance account resolution, mirroring customer_credit_account.
CREATE OR REPLACE FUNCTION public.vendor_advance_account(_business_id uuid)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_id uuid;
BEGIN
  SELECT account_id INTO v_id
    FROM public.default_account_settings
   WHERE business_id = _business_id AND setting_key = 'vendor_advances';
  IF v_id IS NULL THEN
    SELECT account_id INTO v_id
      FROM public.default_account_settings
     WHERE business_id = _business_id AND setting_key = 'vendor_credit';
  END IF;
  RETURN v_id;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.vendor_advance_account(uuid) TO authenticated, service_role;

-- 4. The AP mirror of record_advance_payment: money out with nothing to apply it
--    to yet. Dr Vendor Credits (asset) / Cr Bank.
CREATE OR REPLACE FUNCTION public.record_vendor_advance_payment(
  _org_id uuid,
  _business_id uuid,
  _vendor_id uuid,
  _amount numeric,
  _payment_date date,
  _payment_method text DEFAULT 'bank_transfer',
  _reference text DEFAULT NULL,
  _notes text DEFAULT NULL,
  _created_by uuid DEFAULT NULL,
  _bank_account_id uuid DEFAULT NULL,
  _bank_gl_account_id uuid DEFAULT NULL,
  _advance_asset_account_id uuid DEFAULT NULL,
  _branch_id uuid DEFAULT NULL,
  _request_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_existing        record;
  v_payment_id      uuid;
  v_je_id           uuid;
  v_vendor_name     text;
  v_bank_gl         uuid;
  v_advance_account uuid;
  v_account_ok      int;
BEGIN
  IF _org_id IS NULL OR _business_id IS NULL THEN
    RAISE EXCEPTION 'Workspace and company are required for a supplier advance.';
  END IF;
  IF _amount IS NULL OR _amount <= 0 THEN
    RAISE EXCEPTION 'Advance amount must be positive.';
  END IF;
  IF _vendor_id IS NULL THEN
    RAISE EXCEPTION 'A supplier is required for an advance payment.';
  END IF;
  IF NOT public.is_period_open(_business_id, _payment_date) THEN
    RAISE EXCEPTION 'Payment date falls in a closed fiscal period.' USING ERRCODE = '22023';
  END IF;

  -- Idempotent replay (Tranche 1 contract).
  IF _request_id IS NOT NULL THEN
    SELECT id, journal_entry_id, amount INTO v_existing
      FROM public.bill_payments
     WHERE organization_id = _org_id AND client_request_id = _request_id
     LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'bill_payment_id', v_existing.id,
        'journal_entry_id', v_existing.journal_entry_id,
        'amount', v_existing.amount,
        'idempotent_replay', true
      );
    END IF;
  END IF;

  SELECT name INTO v_vendor_name
    FROM public.contacts
   WHERE id = _vendor_id
     AND organization_id = _org_id
     AND (business_id = _business_id OR business_id IS NULL);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Supplier not found in the active workspace/company.';
  END IF;

  IF _branch_id IS NOT NULL THEN
    PERFORM 1 FROM public.branches
     WHERE id = _branch_id AND organization_id = _org_id AND business_id = _business_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Selected branch does not belong to the active company.';
    END IF;
  END IF;

  v_bank_gl := _bank_gl_account_id;
  IF v_bank_gl IS NULL AND _bank_account_id IS NOT NULL THEN
    SELECT account_id INTO v_bank_gl FROM public.bank_accounts WHERE id = _bank_account_id;
  END IF;
  IF v_bank_gl IS NULL THEN
    RAISE EXCEPTION 'A bank or cash account is required for a supplier advance.';
  END IF;

  v_advance_account := COALESCE(_advance_asset_account_id, public.vendor_advance_account(_business_id));
  IF v_advance_account IS NULL THEN
    RAISE EXCEPTION 'Vendor Credits account is not configured for this company.'
      USING HINT = 'Settings → Default Accounts';
  END IF;

  SELECT count(*) INTO v_account_ok
    FROM public.accounts
   WHERE id = v_advance_account
     AND organization_id = _org_id AND business_id = _business_id
     AND account_type = 'asset'::account_type
     AND COALESCE(is_header, false) = false;
  IF v_account_ok = 0 THEN
    RAISE EXCEPTION 'Vendor Credits account must be a posting asset account in the active company.';
  END IF;

  INSERT INTO public.bill_payments (
    organization_id, business_id, branch_id, vendor_id, bank_account_id,
    payment_date, amount, payment_method, reference, notes, created_by,
    status, client_request_id
  ) VALUES (
    _org_id, _business_id, _branch_id, _vendor_id, _bank_account_id,
    _payment_date, _amount, _payment_method, _reference,
    COALESCE(_notes, 'Advance to supplier (unapplied)'), _created_by,
    'completed', _request_id
  ) RETURNING id INTO v_payment_id;

  v_je_id := public.post_journal_entry_atomic(
    _org_id, _business_id,
    public.generate_next_je_number(_org_id, _business_id),
    _payment_date,
    'VADV-' || substr(v_payment_id::text, 1, 8),
    'Advance payment to ' || v_vendor_name,
    'bill_payment', v_payment_id, _created_by, false, false,
    jsonb_build_array(
      jsonb_build_object('account_id', v_advance_account, 'debit', _amount, 'credit', 0,
        'description', 'Advance to ' || v_vendor_name),
      jsonb_build_object('account_id', v_bank_gl, 'debit', 0, 'credit', _amount,
        'description', 'Cash paid to ' || v_vendor_name)
    ),
    NULL, NULL, NULL, _branch_id
  );

  UPDATE public.bill_payments
     SET journal_entry_id = v_je_id, updated_at = now()
   WHERE id = v_payment_id;

  RETURN jsonb_build_object(
    'bill_payment_id', v_payment_id,
    'journal_entry_id', v_je_id,
    'amount', _amount,
    'idempotent_replay', false
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.record_vendor_advance_payment(
  uuid, uuid, uuid, numeric, date, text, text, text, uuid, uuid, uuid, uuid, uuid, text
) TO authenticated, service_role;