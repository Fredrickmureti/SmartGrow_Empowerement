-- ============================================================
-- Cross-module posting-authority cleanup (Sales/Purchases/Finance)
-- ============================================================

-- 1. Drop legacy COGS trigger that races with application-level COGS posting.
--    The app posts COGS in useDeliveryNotes.markAsDelivered (and confirmInvoiceGL).
DROP TRIGGER IF EXISTS trigger_post_cogs_on_sale_movement ON public.stock_movements;
DROP TRIGGER IF EXISTS post_cogs_on_sale_movement_trigger ON public.stock_movements;
DROP FUNCTION IF EXISTS public.post_cogs_on_sale_movement() CASCADE;

-- 2. Drop stale record_payment_atomic 10-arg overload
--    (canonical: 15-arg version with _business_id uuid).
DROP FUNCTION IF EXISTS public.record_payment_atomic(
  uuid, uuid, uuid, numeric, date, payment_method_enum, text, text, uuid, uuid
);

-- 3. Drop stale create_invoice_stock_movements 3-arg overload
--    (canonical: 4-arg version with p_warehouse_id).
DROP FUNCTION IF EXISTS public.create_invoice_stock_movements(uuid, uuid, uuid);

-- 4. Harden record_bill_payment_atomic: raise on missing GL accounts
--    instead of silently skipping JE creation. Preserves the existing
--    retry logic, return type (jsonb), and bills.journal_entry_id update.
CREATE OR REPLACE FUNCTION public.record_bill_payment_atomic(
  _org_id uuid,
  _business_id uuid,
  _bill_id uuid,
  _amount numeric,
  _payment_date date,
  _payment_method text DEFAULT 'bank_transfer'::text,
  _reference text DEFAULT NULL::text,
  _notes text DEFAULT NULL::text,
  _bank_account_id uuid DEFAULT NULL::uuid,
  _created_by uuid DEFAULT NULL::uuid,
  _ap_account_id uuid DEFAULT NULL::uuid,
  _cash_account_id uuid DEFAULT NULL::uuid,
  _je_entry_number text DEFAULT NULL::text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_payment_id UUID;
  v_bill RECORD;
  v_new_amount_paid NUMERIC;
  v_new_status bill_status;
  v_je_id UUID;
  v_je_number TEXT;
  v_result JSONB;
  v_attempts INT := 0;
  v_max_attempts INT := 20;
BEGIN
  -- DEFENSE-IN-DEPTH: refuse to record a payment without GL accounts.
  -- Silent JE-skip causes irreparable sub-ledger / GL drift.
  IF _ap_account_id IS NULL OR _cash_account_id IS NULL THEN
    RAISE EXCEPTION 'Cannot record bill payment: missing GL account mapping (AP=%, Cash=%). Configure default accounts in Settings > Finance.',
      _ap_account_id, _cash_account_id;
  END IF;

  -- Step 1: Lock the bill row
  SELECT id, bill_number, total, amount_paid, status, journal_entry_id
    INTO v_bill
    FROM bills
   WHERE id = _bill_id
     AND organization_id = _org_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Bill not found';
  END IF;

  IF _amount > (v_bill.total - COALESCE(v_bill.amount_paid, 0)) THEN
    RAISE EXCEPTION 'Payment amount (%) exceeds balance due (%)', _amount, (v_bill.total - COALESCE(v_bill.amount_paid, 0));
  END IF;

  -- Step 2: Insert payment record
  INSERT INTO bill_payments (
    organization_id, business_id, bill_id, amount,
    payment_date, payment_method, reference, notes, bank_account_id, created_by
  ) VALUES (
    _org_id, _business_id, _bill_id, _amount,
    _payment_date, _payment_method, _reference, _notes, _bank_account_id, _created_by
  ) RETURNING id INTO v_payment_id;

  -- Step 3: Calculate new status
  v_new_amount_paid := COALESCE(v_bill.amount_paid, 0) + _amount;
  IF v_new_amount_paid >= v_bill.total THEN
    v_new_status := 'paid'::bill_status;
  ELSE
    v_new_status := 'partial'::bill_status;
  END IF;

  -- Step 4: Create journal entry (collision-safe number allocation)
  LOOP
    v_attempts := v_attempts + 1;

    IF v_attempts > v_max_attempts THEN
      RAISE EXCEPTION 'Unable to allocate unique journal entry number after % attempts for org %', v_max_attempts, _org_id;
    END IF;

    v_je_number := generate_next_je_number(_org_id);

    BEGIN
      INSERT INTO journal_entries (
        organization_id, business_id, entry_number, entry_date,
        reference, description, source_type, source_id, status, created_by
      ) VALUES (
        _org_id, _business_id, v_je_number,
        _payment_date, 'BP-' || v_bill.bill_number, 'Bill payment for ' || v_bill.bill_number,
        'bill_payment', v_payment_id, 'posted', _created_by
      ) RETURNING id INTO v_je_id;

      EXIT; -- success
    EXCEPTION
      WHEN unique_violation THEN
        IF POSITION('journal_entries_organization_id_entry_number_key' IN SQLERRM) > 0 THEN
          CONTINUE;
        ELSE
          RAISE;
        END IF;
    END;
  END LOOP;

  INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description)
  VALUES (v_je_id, _ap_account_id, _amount, 0, 'Bill payment ' || v_bill.bill_number || ' - AP reduction');

  INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description)
  VALUES (v_je_id, _cash_account_id, 0, _amount, 'Bill payment ' || v_bill.bill_number || ' - Cash/Bank');

  UPDATE bill_payments SET journal_entry_id = v_je_id WHERE id = v_payment_id;

  -- Step 5: Update bill
  UPDATE bills
     SET amount_paid = v_new_amount_paid,
         status = v_new_status,
         journal_entry_id = v_je_id
   WHERE id = _bill_id;

  v_result := jsonb_build_object(
    'payment_id', v_payment_id,
    'journal_entry_id', v_je_id,
    'journal_entry_number', v_je_number,
    'new_status', v_new_status::TEXT,
    'new_amount_paid', v_new_amount_paid,
    'je_number_attempts', v_attempts
  );

  RETURN v_result;
END;
$function$;

-- 5. Source-type consistency linter view.
--    Lists posted JEs whose source_type is NULL or outside the canonical set.
CREATE OR REPLACE VIEW public.v_je_source_consistency AS
SELECT
  je.id,
  je.organization_id,
  je.entry_number,
  je.entry_date,
  je.source_type,
  je.source_id,
  je.source_subtype,
  je.reference,
  je.description,
  CASE
    WHEN je.source_type IS NULL THEN 'NULL_SOURCE_TYPE'
    ELSE 'UNKNOWN_SOURCE_TYPE'
  END AS issue
FROM public.journal_entries je
WHERE je.status = 'posted'
  AND (
    je.source_type IS NULL
    OR je.source_type NOT IN (
      'invoice','bill','payment','bill_payment','expense',
      'pos_sale','pos_shift','payroll','manual','credit_note',
      'vendor_credit_note','bank_recon','year_end_closing',
      'purchase_return','sales_return','migration','stock_adjustment',
      'asset_acquisition','asset_disposal','depreciation','opening_balance',
      'owner_investment','owner_drawing','bank_transfer','loan_received',
      'loan_payment','delivery','scrap','physical_count','reversal'
    )
  );

COMMENT ON VIEW public.v_je_source_consistency IS
  'Lints posted journal entries with NULL or non-canonical source_type. Should always be empty in a healthy ledger.';