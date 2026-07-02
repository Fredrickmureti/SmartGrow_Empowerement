-- ============================================================================
-- Fix payment posting: propagate business_id/branch_id to journal_entry_lines
-- ============================================================================
-- Root cause: record_payment_atomic and create_journal_entry_atomic insert
-- journal_entry_lines without setting business_id, causing the multi-company
-- isolation trigger trg_enforce_je_line_company_match to reject the insert.
--
-- Fix:
--   1. Rewrite record_payment_atomic to set business_id + branch_id on lines.
--   2. Rewrite create_journal_entry_atomic to set business_id on lines.
--   3. Add a BEFORE INSERT trigger that defaults line business_id/branch_id
--      from the parent journal entry, as a defense-in-depth safety net for
--      every other JE writer (manual, payroll GL, depreciation, reversal,
--      etc.). The existing match trigger remains the strict guard.
-- ============================================================================


-- 1. Defense-in-depth: default line context from parent JE -------------------
CREATE OR REPLACE FUNCTION public.default_je_line_context_from_parent()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  parent_business uuid;
  parent_branch   uuid;
BEGIN
  IF NEW.business_id IS NOT NULL AND NEW.branch_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT business_id, branch_id
    INTO parent_business, parent_branch
    FROM public.journal_entries
   WHERE id = NEW.journal_entry_id;

  IF parent_business IS NULL THEN
    -- Let the existing strict match trigger raise the canonical error.
    RETURN NEW;
  END IF;

  IF NEW.business_id IS NULL THEN
    NEW.business_id := parent_business;
  END IF;

  -- Only default branch_id from the parent if the line has none. We never
  -- override an explicit branch_id; the strict match trigger will reject
  -- any cross-branch attempt.
  IF NEW.branch_id IS NULL AND parent_branch IS NOT NULL THEN
    NEW.branch_id := parent_branch;
  END IF;

  RETURN NEW;
END;
$$;

-- Name is alphabetically before trg_enforce_je_line_company_match so it fires
-- first (Postgres orders BEFORE triggers by name).
DROP TRIGGER IF EXISTS trg_default_je_line_context ON public.journal_entry_lines;
CREATE TRIGGER trg_default_je_line_context
  BEFORE INSERT ON public.journal_entry_lines
  FOR EACH ROW
  EXECUTE FUNCTION public.default_je_line_context_from_parent();


-- 2. Fix create_journal_entry_atomic ----------------------------------------
CREATE OR REPLACE FUNCTION public.create_journal_entry_atomic(
  _org_id uuid,
  _business_id uuid,
  _entry_number text,
  _entry_date date,
  _description text,
  _reference text,
  _is_adjusting boolean,
  _is_closing boolean,
  _created_by uuid,
  _lines jsonb,
  _branch_id uuid DEFAULT NULL::uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _entry_id uuid;
  _line jsonb;
  _total_debit numeric := 0;
  _total_credit numeric := 0;
  _sort integer := 0;
BEGIN
  FOR _line IN SELECT * FROM jsonb_array_elements(_lines) LOOP
    _total_debit  := _total_debit  + COALESCE((_line->>'debit')::numeric, 0);
    _total_credit := _total_credit + COALESCE((_line->>'credit')::numeric, 0);
  END LOOP;

  IF ABS(_total_debit - _total_credit) > 0.01 THEN
    RAISE EXCEPTION 'Journal entry is not balanced: debits (%) != credits (%)', _total_debit, _total_credit;
  END IF;

  INSERT INTO journal_entries (
    organization_id, business_id, branch_id, entry_number, entry_date,
    description, reference, is_adjusting, is_closing,
    status, created_by
  ) VALUES (
    _org_id, _business_id, _branch_id, _entry_number, _entry_date,
    _description, _reference, _is_adjusting, _is_closing,
    'posted', _created_by
  )
  RETURNING id INTO _entry_id;

  FOR _line IN SELECT * FROM jsonb_array_elements(_lines) LOOP
    INSERT INTO journal_entry_lines (
      journal_entry_id, account_id, description,
      debit, credit, contact_id, sort_order,
      business_id, branch_id
    ) VALUES (
      _entry_id,
      (_line->>'account_id')::uuid,
      _line->>'description',
      COALESCE((_line->>'debit')::numeric, 0),
      COALESCE((_line->>'credit')::numeric, 0),
      CASE WHEN _line->>'contact_id' IS NOT NULL THEN (_line->>'contact_id')::uuid ELSE NULL END,
      _sort,
      _business_id,
      _branch_id
    );
    _sort := _sort + 1;
  END LOOP;

  RETURN _entry_id;
END;
$$;


-- 3. Fix record_payment_atomic ----------------------------------------------
CREATE OR REPLACE FUNCTION public.record_payment_atomic(
  _org_id uuid,
  _business_id uuid,
  _invoice_id uuid,
  _contact_id uuid,
  _amount numeric,
  _payment_date date,
  _payment_method text DEFAULT 'bank_transfer'::text,
  _reference text DEFAULT NULL::text,
  _notes text DEFAULT NULL::text,
  _receipt_number text DEFAULT NULL::text,
  _created_by uuid DEFAULT NULL::uuid,
  _deposit_account_id uuid DEFAULT NULL::uuid,
  _receivable_account_id uuid DEFAULT NULL::uuid,
  _je_entry_number text DEFAULT NULL::text,
  _customer_credit_account_id uuid DEFAULT NULL::uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_payment_id UUID;
  v_invoice RECORD;
  v_balance_due NUMERIC;
  v_overpayment NUMERIC := 0;
  v_applied_to_invoice NUMERIC;
  v_new_amount_paid NUMERIC;
  v_new_status invoice_status;
  v_je_id UUID;
  v_je_number TEXT;
  v_result JSONB;
  v_retry INT := 0;
  v_max_retries INT := 5;
  v_currency TEXT;
  v_effective_business_id UUID;
BEGIN
  IF _deposit_account_id IS NULL THEN
    RAISE EXCEPTION 'Deposit account is required. Cannot record payment without a valid GL deposit account.';
  END IF;
  IF _receivable_account_id IS NULL THEN
    RAISE EXCEPTION 'Accounts Receivable account is required. Cannot record payment without a valid AR account.';
  END IF;

  SELECT id, invoice_number, total, amount_paid, status, currency, business_id, branch_id
    INTO v_invoice
    FROM invoices
   WHERE id = _invoice_id
     AND organization_id = _org_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found';
  END IF;

  v_effective_business_id := COALESCE(v_invoice.business_id, _business_id);
  IF v_effective_business_id IS NULL THEN
    RAISE EXCEPTION 'business_id is required for payment posting (invoice % has no business and none was supplied)', v_invoice.invoice_number
      USING ERRCODE = '22023';
  END IF;
  IF v_invoice.business_id IS NOT NULL
     AND _business_id IS NOT NULL
     AND v_invoice.business_id <> _business_id THEN
    RAISE EXCEPTION 'Cannot record payment: invoice % belongs to a different company than the active session', v_invoice.invoice_number
      USING ERRCODE = '42501';
  END IF;

  v_currency := COALESCE(
    NULLIF(v_invoice.currency, ''),
    (SELECT base_currency FROM businesses WHERE id = v_effective_business_id),
    'USD'
  );

  v_balance_due := v_invoice.total - COALESCE(v_invoice.amount_paid, 0);

  IF _amount > v_balance_due THEN
    v_applied_to_invoice := v_balance_due;
    v_overpayment := _amount - v_balance_due;
  ELSE
    v_applied_to_invoice := _amount;
    v_overpayment := 0;
  END IF;

  IF v_overpayment > 0 AND _customer_credit_account_id IS NULL THEN
    RAISE EXCEPTION 'Customer credit account not configured. Cannot process overpayment of %. Please configure the Customer Deposits & Advances account in Finance Settings.', v_overpayment;
  END IF;

  INSERT INTO payments (
    organization_id, business_id, invoice_id, contact_id, amount,
    payment_date, payment_method, reference, notes, receipt_number, created_by,
    deposit_account_id
  ) VALUES (
    _org_id, v_effective_business_id, _invoice_id, _contact_id, _amount,
    _payment_date, _payment_method::payment_method, _reference, _notes, _receipt_number, _created_by,
    _deposit_account_id
  ) RETURNING id INTO v_payment_id;

  v_new_amount_paid := COALESCE(v_invoice.amount_paid, 0) + v_applied_to_invoice;
  IF v_new_amount_paid >= v_invoice.total THEN
    v_new_status := 'paid'::invoice_status;
  ELSE
    v_new_status := 'partial'::invoice_status;
  END IF;

  LOOP
    BEGIN
      v_je_number := generate_next_je_number(_org_id, v_effective_business_id);

      INSERT INTO journal_entries (
        organization_id, business_id, branch_id, entry_number, entry_date,
        reference, description, source_type, source_id, status, created_by
      ) VALUES (
        _org_id, v_effective_business_id, v_invoice.branch_id, v_je_number,
        _payment_date, 'PMT-' || v_invoice.invoice_number,
        'Payment for invoice ' || v_invoice.invoice_number,
        'payment', v_payment_id, 'posted', _created_by
      ) RETURNING id INTO v_je_id;

      EXIT;
    EXCEPTION WHEN unique_violation THEN
      v_retry := v_retry + 1;
      IF v_retry >= v_max_retries THEN
        RAISE EXCEPTION 'Could not generate unique JE number after % retries', v_max_retries;
      END IF;
    END;
  END LOOP;

  -- Debit cash/bank/payment account (full amount including overpayment)
  INSERT INTO journal_entry_lines (
    journal_entry_id, account_id, debit, credit, description,
    business_id, branch_id
  )
  VALUES (
    v_je_id, _deposit_account_id, _amount, 0,
    'Payment received - ' || v_invoice.invoice_number,
    v_effective_business_id, v_invoice.branch_id
  );

  -- Credit Accounts Receivable (only the amount actually applied to invoice)
  INSERT INTO journal_entry_lines (
    journal_entry_id, account_id, debit, credit, description,
    business_id, branch_id
  )
  VALUES (
    v_je_id, _receivable_account_id, 0, v_applied_to_invoice,
    'AR settlement - ' || v_invoice.invoice_number,
    v_effective_business_id, v_invoice.branch_id
  );

  -- Credit customer deposits/advances for any overpayment
  IF v_overpayment > 0 THEN
    INSERT INTO journal_entry_lines (
      journal_entry_id, account_id, debit, credit, description,
      business_id, branch_id
    )
    VALUES (
      v_je_id, _customer_credit_account_id, 0, v_overpayment,
      'Customer credit - overpayment on ' || v_invoice.invoice_number,
      v_effective_business_id, v_invoice.branch_id
    );
  END IF;

  UPDATE invoices
     SET amount_paid = v_new_amount_paid,
         status = v_new_status,
         updated_at = now()
   WHERE id = _invoice_id;

  v_result := jsonb_build_object(
    'payment_id', v_payment_id,
    'journal_entry_id', v_je_id,
    'journal_entry_number', v_je_number,
    'applied_amount', v_applied_to_invoice,
    'overpayment', v_overpayment,
    'new_status', v_new_status,
    'business_id', v_effective_business_id
  );

  RETURN v_result;
END;
$$;