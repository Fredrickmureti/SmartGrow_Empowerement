-- =====================================================
-- PHASE 1: AUTOMATIC GL POSTING & SCHEDULING (Corrected)
-- =====================================================

-- =====================================================
-- 1. ADD JOURNAL ENTRY REFERENCES
-- =====================================================

-- Add journal_entry_id to invoices
ALTER TABLE public.invoices 
ADD COLUMN IF NOT EXISTS journal_entry_id UUID REFERENCES public.journal_entries(id) ON DELETE SET NULL;

-- Add journal_entry_id to bills  
ALTER TABLE public.bills
ADD COLUMN IF NOT EXISTS journal_entry_id UUID REFERENCES public.journal_entries(id) ON DELETE SET NULL;

-- Add journal_entry_id to payments
ALTER TABLE public.payments
ADD COLUMN IF NOT EXISTS journal_entry_id UUID REFERENCES public.journal_entries(id) ON DELETE SET NULL;

-- Add journal_entry_id to bill_payments
ALTER TABLE public.bill_payments
ADD COLUMN IF NOT EXISTS journal_entry_id UUID REFERENCES public.journal_entries(id) ON DELETE SET NULL;

-- Add journal_entry_id to expenses
ALTER TABLE public.expenses
ADD COLUMN IF NOT EXISTS journal_entry_id UUID REFERENCES public.journal_entries(id) ON DELETE SET NULL;

-- =====================================================
-- 2. DEFAULT ACCOUNT MAPPINGS TABLE
-- =====================================================

CREATE TABLE IF NOT EXISTS public.default_account_mappings (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id UUID REFERENCES public.businesses(id) ON DELETE CASCADE,
  mapping_type TEXT NOT NULL,
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  is_default BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(organization_id, business_id, mapping_type)
);

ALTER TABLE public.default_account_mappings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view default account mappings in their orgs" 
ON public.default_account_mappings FOR SELECT 
USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can manage default account mappings in their orgs" 
ON public.default_account_mappings FOR ALL 
USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

-- =====================================================
-- 3. HELPER FUNCTION: GET NEXT JOURNAL ENTRY NUMBER
-- =====================================================

CREATE OR REPLACE FUNCTION public.get_next_journal_entry_number(_org_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  next_num INTEGER;
BEGIN
  SELECT COALESCE(
    MAX(CAST(NULLIF(REGEXP_REPLACE(entry_number, '[^0-9]', '', 'g'), '') AS INTEGER)),
    0
  ) + 1
  INTO next_num
  FROM journal_entries
  WHERE organization_id = _org_id;

  RETURN 'JE-' || LPAD(next_num::TEXT, 5, '0');
END;
$$;

-- =====================================================
-- 4. AUTO-CREATE JOURNAL ENTRY FOR INVOICES
-- =====================================================

CREATE OR REPLACE FUNCTION public.create_invoice_journal_entry()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_entry_number TEXT;
  v_journal_entry_id UUID;
  v_ar_account_id UUID;
  v_revenue_account_id UUID;
  v_tax_account_id UUID;
BEGIN
  -- Only create journal entry when invoice is sent (not draft)
  IF NEW.status NOT IN ('sent', 'viewed', 'partial', 'paid') THEN
    RETURN NEW;
  END IF;
  
  -- Skip if already has journal entry
  IF NEW.journal_entry_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  
  -- Get Accounts Receivable
  SELECT id INTO v_ar_account_id
  FROM accounts
  WHERE organization_id = NEW.organization_id
    AND (code LIKE '1200%' OR code LIKE '110%' OR LOWER(name) LIKE '%accounts receivable%' OR LOWER(name) LIKE '%trade receivable%')
    AND account_type = 'asset'
    AND is_active = true
  LIMIT 1;
  
  -- Get Sales Revenue account
  SELECT id INTO v_revenue_account_id
  FROM accounts
  WHERE organization_id = NEW.organization_id
    AND (code LIKE '4000%' OR code LIKE '400%' OR LOWER(name) LIKE '%sales%' OR LOWER(name) LIKE '%revenue%')
    AND account_type = 'income'
    AND is_active = true
  LIMIT 1;
  
  -- Get Tax Payable account
  SELECT id INTO v_tax_account_id
  FROM accounts
  WHERE organization_id = NEW.organization_id
    AND (LOWER(name) LIKE '%tax payable%' OR LOWER(name) LIKE '%vat payable%' OR LOWER(name) LIKE '%output tax%')
    AND account_type = 'liability'
    AND is_active = true
  LIMIT 1;
  
  -- If no AR or Revenue account found, skip
  IF v_ar_account_id IS NULL OR v_revenue_account_id IS NULL THEN
    RETURN NEW;
  END IF;
  
  v_entry_number := get_next_journal_entry_number(NEW.organization_id);
  
  INSERT INTO journal_entries (
    organization_id,
    business_id,
    entry_number,
    entry_date,
    description,
    reference,
    status,
    created_by
  ) VALUES (
    NEW.organization_id,
    NEW.business_id,
    v_entry_number,
    NEW.issue_date,
    'Invoice ' || NEW.invoice_number || ' - Auto-posted',
    NEW.invoice_number,
    'posted',
    NEW.created_by
  )
  RETURNING id INTO v_journal_entry_id;
  
  -- Dr. Accounts Receivable (Total)
  INSERT INTO journal_entry_lines (journal_entry_id, account_id, description, debit, credit, contact_id, sort_order)
  VALUES (v_journal_entry_id, v_ar_account_id, 'Invoice ' || NEW.invoice_number, NEW.total, 0, NEW.contact_id, 0);
  
  -- Cr. Sales Revenue (Subtotal)
  INSERT INTO journal_entry_lines (journal_entry_id, account_id, description, debit, credit, contact_id, sort_order)
  VALUES (v_journal_entry_id, v_revenue_account_id, 'Sales - Invoice ' || NEW.invoice_number, 0, NEW.subtotal, NEW.contact_id, 1);
  
  -- Cr. Tax Payable (Tax Amount)
  IF NEW.tax_amount > 0 AND v_tax_account_id IS NOT NULL THEN
    INSERT INTO journal_entry_lines (journal_entry_id, account_id, description, debit, credit, contact_id, sort_order)
    VALUES (v_journal_entry_id, v_tax_account_id, 'VAT/Tax - Invoice ' || NEW.invoice_number, 0, NEW.tax_amount, NEW.contact_id, 2);
  END IF;
  
  NEW.journal_entry_id := v_journal_entry_id;
  
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_invoice_journal_entry ON public.invoices;
CREATE TRIGGER trigger_invoice_journal_entry
  BEFORE UPDATE ON public.invoices
  FOR EACH ROW
  WHEN (OLD.status = 'draft' AND NEW.status IN ('sent', 'viewed', 'partial', 'paid'))
  EXECUTE FUNCTION create_invoice_journal_entry();

-- =====================================================
-- 5. AUTO-CREATE JOURNAL ENTRY FOR BILLS (Corrected status values)
-- =====================================================

CREATE OR REPLACE FUNCTION public.create_bill_journal_entry()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_entry_number TEXT;
  v_journal_entry_id UUID;
  v_ap_account_id UUID;
  v_expense_account_id UUID;
  v_tax_account_id UUID;
BEGIN
  -- Only create when bill is received/approved (not draft)
  -- bill_status enum: draft, received, partial, paid, overdue, void
  IF NEW.status NOT IN ('received', 'partial', 'paid') THEN
    RETURN NEW;
  END IF;
  
  IF NEW.journal_entry_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  
  SELECT id INTO v_ap_account_id
  FROM accounts
  WHERE organization_id = NEW.organization_id
    AND (code LIKE '2000%' OR code LIKE '200%' OR LOWER(name) LIKE '%accounts payable%' OR LOWER(name) LIKE '%trade payable%')
    AND account_type = 'liability'
    AND is_active = true
  LIMIT 1;
  
  v_expense_account_id := NEW.account_id;
  IF v_expense_account_id IS NULL THEN
    SELECT id INTO v_expense_account_id
    FROM accounts
    WHERE organization_id = NEW.organization_id
      AND (code LIKE '5000%' OR code LIKE '600%' OR LOWER(name) LIKE '%expense%' OR LOWER(name) LIKE '%cost%')
      AND account_type = 'expense'
      AND is_active = true
    LIMIT 1;
  END IF;
  
  SELECT id INTO v_tax_account_id
  FROM accounts
  WHERE organization_id = NEW.organization_id
    AND (LOWER(name) LIKE '%input tax%' OR LOWER(name) LIKE '%vat receivable%' OR LOWER(name) LIKE '%tax receivable%')
    AND account_type = 'asset'
    AND is_active = true
  LIMIT 1;
  
  IF v_ap_account_id IS NULL OR v_expense_account_id IS NULL THEN
    RETURN NEW;
  END IF;
  
  v_entry_number := get_next_journal_entry_number(NEW.organization_id);
  
  INSERT INTO journal_entries (organization_id, business_id, entry_number, entry_date, description, reference, status, created_by)
  VALUES (NEW.organization_id, NEW.business_id, v_entry_number, NEW.bill_date, 'Bill ' || NEW.bill_number || ' - Auto-posted', NEW.bill_number, 'posted', NEW.created_by)
  RETURNING id INTO v_journal_entry_id;
  
  -- Dr. Expense (Subtotal)
  INSERT INTO journal_entry_lines (journal_entry_id, account_id, description, debit, credit, contact_id, sort_order)
  VALUES (v_journal_entry_id, v_expense_account_id, 'Bill ' || NEW.bill_number, NEW.subtotal, 0, NEW.vendor_id, 0);
  
  -- Dr. Input Tax
  IF NEW.tax_amount > 0 AND v_tax_account_id IS NOT NULL THEN
    INSERT INTO journal_entry_lines (journal_entry_id, account_id, description, debit, credit, contact_id, sort_order)
    VALUES (v_journal_entry_id, v_tax_account_id, 'Input Tax - Bill ' || NEW.bill_number, NEW.tax_amount, 0, NEW.vendor_id, 1);
  END IF;
  
  -- Cr. Accounts Payable (Total)
  INSERT INTO journal_entry_lines (journal_entry_id, account_id, description, debit, credit, contact_id, sort_order)
  VALUES (v_journal_entry_id, v_ap_account_id, 'Payable - Bill ' || NEW.bill_number, 0, NEW.total, NEW.vendor_id, 2);
  
  NEW.journal_entry_id := v_journal_entry_id;
  
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_bill_journal_entry ON public.bills;
CREATE TRIGGER trigger_bill_journal_entry
  BEFORE UPDATE ON public.bills
  FOR EACH ROW
  WHEN (OLD.status = 'draft' AND NEW.status IN ('received', 'partial', 'paid'))
  EXECUTE FUNCTION create_bill_journal_entry();

-- =====================================================
-- 6. AUTO-CREATE JOURNAL ENTRY FOR PAYMENTS (Received)
-- =====================================================

CREATE OR REPLACE FUNCTION public.create_payment_journal_entry()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_entry_number TEXT;
  v_journal_entry_id UUID;
  v_bank_account_id UUID;
  v_ar_account_id UUID;
  v_invoice_number TEXT;
BEGIN
  IF NEW.journal_entry_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  
  SELECT id INTO v_bank_account_id
  FROM accounts
  WHERE organization_id = NEW.organization_id
    AND (
      (NEW.payment_method IN ('bank_transfer', 'check') AND (LOWER(name) LIKE '%bank%' OR code LIKE '1100%'))
      OR (NEW.payment_method = 'cash' AND (LOWER(name) LIKE '%cash%' OR code LIKE '1000%'))
      OR (NEW.payment_method IN ('credit_card', 'mpesa') AND (LOWER(name) LIKE '%bank%' OR LOWER(name) LIKE '%cash%'))
    )
    AND account_type = 'asset'
    AND is_active = true
  LIMIT 1;
  
  SELECT id INTO v_ar_account_id
  FROM accounts
  WHERE organization_id = NEW.organization_id
    AND (code LIKE '1200%' OR code LIKE '110%' OR LOWER(name) LIKE '%accounts receivable%' OR LOWER(name) LIKE '%trade receivable%')
    AND account_type = 'asset'
    AND is_active = true
  LIMIT 1;
  
  IF NEW.invoice_id IS NOT NULL THEN
    SELECT invoice_number INTO v_invoice_number FROM invoices WHERE id = NEW.invoice_id;
  END IF;
  
  IF v_bank_account_id IS NULL OR v_ar_account_id IS NULL THEN
    RETURN NEW;
  END IF;
  
  v_entry_number := get_next_journal_entry_number(NEW.organization_id);
  
  INSERT INTO journal_entries (organization_id, business_id, entry_number, entry_date, description, reference, status, created_by)
  VALUES (NEW.organization_id, NEW.business_id, v_entry_number, NEW.payment_date, 'Payment received' || COALESCE(' - ' || v_invoice_number, '') || ' - ' || COALESCE(NEW.receipt_number, ''), NEW.receipt_number, 'posted', NEW.created_by)
  RETURNING id INTO v_journal_entry_id;
  
  -- Dr. Bank/Cash
  INSERT INTO journal_entry_lines (journal_entry_id, account_id, description, debit, credit, contact_id, sort_order)
  VALUES (v_journal_entry_id, v_bank_account_id, 'Payment received' || COALESCE(' - ' || v_invoice_number, ''), NEW.amount, 0, NEW.contact_id, 0);
  
  -- Cr. Accounts Receivable
  INSERT INTO journal_entry_lines (journal_entry_id, account_id, description, debit, credit, contact_id, sort_order)
  VALUES (v_journal_entry_id, v_ar_account_id, 'AR reduction' || COALESCE(' - ' || v_invoice_number, ''), 0, NEW.amount, NEW.contact_id, 1);
  
  NEW.journal_entry_id := v_journal_entry_id;
  
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_payment_journal_entry ON public.payments;
CREATE TRIGGER trigger_payment_journal_entry
  BEFORE INSERT ON public.payments
  FOR EACH ROW
  EXECUTE FUNCTION create_payment_journal_entry();

-- =====================================================
-- 7. AUTO-CREATE JOURNAL ENTRY FOR BILL PAYMENTS
-- =====================================================

CREATE OR REPLACE FUNCTION public.create_bill_payment_journal_entry()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_entry_number TEXT;
  v_journal_entry_id UUID;
  v_bank_account_id UUID;
  v_ap_account_id UUID;
  v_bill_number TEXT;
BEGIN
  IF NEW.journal_entry_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  
  SELECT id INTO v_bank_account_id
  FROM accounts
  WHERE organization_id = NEW.organization_id
    AND (LOWER(name) LIKE '%bank%' OR LOWER(name) LIKE '%cash%' OR code LIKE '1000%' OR code LIKE '1100%')
    AND account_type = 'asset'
    AND is_active = true
  LIMIT 1;
  
  SELECT id INTO v_ap_account_id
  FROM accounts
  WHERE organization_id = NEW.organization_id
    AND (code LIKE '2000%' OR code LIKE '200%' OR LOWER(name) LIKE '%accounts payable%' OR LOWER(name) LIKE '%trade payable%')
    AND account_type = 'liability'
    AND is_active = true
  LIMIT 1;
  
  IF NEW.bill_id IS NOT NULL THEN
    SELECT bill_number INTO v_bill_number FROM bills WHERE id = NEW.bill_id;
  END IF;
  
  IF v_bank_account_id IS NULL OR v_ap_account_id IS NULL THEN
    RETURN NEW;
  END IF;
  
  v_entry_number := get_next_journal_entry_number(NEW.organization_id);
  
  INSERT INTO journal_entries (organization_id, business_id, entry_number, entry_date, description, reference, status, created_by)
  VALUES (NEW.organization_id, NEW.business_id, v_entry_number, NEW.payment_date, 'Bill payment' || COALESCE(' - ' || v_bill_number, ''), NEW.reference, 'posted', NEW.created_by)
  RETURNING id INTO v_journal_entry_id;
  
  -- Dr. Accounts Payable
  INSERT INTO journal_entry_lines (journal_entry_id, account_id, description, debit, credit, sort_order)
  VALUES (v_journal_entry_id, v_ap_account_id, 'AP reduction' || COALESCE(' - ' || v_bill_number, ''), NEW.amount, 0, 0);
  
  -- Cr. Bank/Cash
  INSERT INTO journal_entry_lines (journal_entry_id, account_id, description, debit, credit, sort_order)
  VALUES (v_journal_entry_id, v_bank_account_id, 'Payment made' || COALESCE(' - ' || v_bill_number, ''), 0, NEW.amount, 1);
  
  NEW.journal_entry_id := v_journal_entry_id;
  
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_bill_payment_journal_entry ON public.bill_payments;
CREATE TRIGGER trigger_bill_payment_journal_entry
  BEFORE INSERT ON public.bill_payments
  FOR EACH ROW
  EXECUTE FUNCTION create_bill_payment_journal_entry();

-- =====================================================
-- 8. AUTO-UPDATE OVERDUE INVOICES
-- =====================================================

CREATE OR REPLACE FUNCTION public.update_overdue_invoices()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  updated_count INTEGER;
BEGIN
  WITH updated AS (
    UPDATE invoices
    SET status = 'overdue', updated_at = now()
    WHERE due_date < CURRENT_DATE AND status IN ('sent', 'viewed', 'partial')
    RETURNING id
  )
  SELECT COUNT(*) INTO updated_count FROM updated;
  
  RETURN updated_count;
END;
$$;

-- =====================================================
-- 9. ADD BUSINESS_ID TO JOURNAL_ENTRIES
-- =====================================================

ALTER TABLE public.journal_entries
ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES public.businesses(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_journal_entries_business_id ON public.journal_entries(business_id);

-- =====================================================
-- 10. PERFORMANCE INDEXES
-- =====================================================

CREATE INDEX IF NOT EXISTS idx_invoices_journal_entry_id ON public.invoices(journal_entry_id);
CREATE INDEX IF NOT EXISTS idx_bills_journal_entry_id ON public.bills(journal_entry_id);
CREATE INDEX IF NOT EXISTS idx_payments_journal_entry_id ON public.payments(journal_entry_id);
CREATE INDEX IF NOT EXISTS idx_bill_payments_journal_entry_id ON public.bill_payments(journal_entry_id);
CREATE INDEX IF NOT EXISTS idx_invoices_overdue_check ON public.invoices(due_date, status) WHERE status IN ('sent', 'viewed', 'partial');
CREATE INDEX IF NOT EXISTS idx_recurring_invoices_next_run ON public.recurring_invoices(next_run_date, is_active) WHERE is_active = true;