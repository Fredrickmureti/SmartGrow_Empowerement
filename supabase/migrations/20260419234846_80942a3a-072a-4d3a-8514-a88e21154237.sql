
DO $$
DECLARE
  t text;
  tbls text[] := ARRAY[
    'sales_orders','estimates','proforma_invoices','recurring_invoices','recurring_journal_templates',
    'credit_notes','customer_statements','sales_returns','delivery_notes','backorders',
    'purchase_orders','purchase_returns','rfqs','goods_receipts','vendor_credit_notes',
    'vendor_statements','vendor_pricelists','payment_requests',
    'products','warehouses','stock_movements','stock_adjustments','price_lists',
    'product_reorder_rules','replenishment_logs','loyalty_programs',
    'bank_accounts','bank_transactions','bank_statements','bank_reconciliation_sessions','reconciliation_sessions',
    'employees','departments','employee_contracts','employee_loans',
    'payroll_runs','payslips','payroll_remittances',
    'attendance','timesheets','timesheet_submissions','leave_requests','leave_allocations',
    'pos_transactions','pos_registers','pos_shifts','pos_daily_sales_summary','pos_daily_summary',
    'contacts','crm_leads','crm_activities','projects',
    'budgets','fixed_assets'
  ];
BEGIN
  FOREACH t IN ARRAY tbls LOOP
    EXECUTE format('ALTER TABLE public.%I ALTER COLUMN business_id SET NOT NULL', t);
  END LOOP;
END$$;

CREATE OR REPLACE FUNCTION public.enforce_bank_txn_business_match()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE acct_biz uuid;
BEGIN
  SELECT business_id INTO acct_biz FROM public.bank_accounts WHERE id = NEW.bank_account_id;
  IF acct_biz IS NULL THEN
    RAISE EXCEPTION 'bank_account % not found', NEW.bank_account_id USING ERRCODE='foreign_key_violation';
  END IF;
  IF acct_biz <> NEW.business_id THEN
    RAISE EXCEPTION 'bank_transaction.business_id (%) must match bank_account.business_id (%)',
      NEW.business_id, acct_biz USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END$$;
DROP TRIGGER IF EXISTS trg_bank_txn_business_match ON public.bank_transactions;
CREATE TRIGGER trg_bank_txn_business_match
BEFORE INSERT OR UPDATE OF bank_account_id, business_id ON public.bank_transactions
FOR EACH ROW EXECUTE FUNCTION public.enforce_bank_txn_business_match();

CREATE OR REPLACE FUNCTION public.enforce_invoice_contact_business_match()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c_biz uuid; c_org uuid;
BEGIN
  IF NEW.contact_id IS NULL THEN RETURN NEW; END IF;
  SELECT business_id, organization_id INTO c_biz, c_org FROM public.contacts WHERE id = NEW.contact_id;
  IF c_org <> NEW.organization_id THEN
    RAISE EXCEPTION 'contact.organization_id (%) must match invoice.organization_id (%)',
      c_org, NEW.organization_id USING ERRCODE='check_violation';
  END IF;
  IF c_biz <> NEW.business_id THEN
    RAISE EXCEPTION 'contact.business_id (%) must match invoice.business_id (%)',
      c_biz, NEW.business_id USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END$$;
DROP TRIGGER IF EXISTS trg_invoice_contact_business_match ON public.invoices;
CREATE TRIGGER trg_invoice_contact_business_match
BEFORE INSERT OR UPDATE OF contact_id, business_id, organization_id ON public.invoices
FOR EACH ROW EXECUTE FUNCTION public.enforce_invoice_contact_business_match();

CREATE OR REPLACE FUNCTION public.enforce_bill_vendor_business_match()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_biz uuid; v_org uuid;
BEGIN
  IF NEW.vendor_id IS NULL THEN RETURN NEW; END IF;
  SELECT business_id, organization_id INTO v_biz, v_org FROM public.contacts WHERE id = NEW.vendor_id;
  IF v_org <> NEW.organization_id THEN
    RAISE EXCEPTION 'vendor.organization_id (%) must match bill.organization_id (%)',
      v_org, NEW.organization_id USING ERRCODE='check_violation';
  END IF;
  IF v_biz <> NEW.business_id THEN
    RAISE EXCEPTION 'vendor.business_id (%) must match bill.business_id (%)',
      v_biz, NEW.business_id USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END$$;
DROP TRIGGER IF EXISTS trg_bill_vendor_business_match ON public.bills;
CREATE TRIGGER trg_bill_vendor_business_match
BEFORE INSERT OR UPDATE OF vendor_id, business_id, organization_id ON public.bills
FOR EACH ROW EXECUTE FUNCTION public.enforce_bill_vendor_business_match();

CREATE UNIQUE INDEX IF NOT EXISTS uq_accounts_biz_code_active
  ON public.accounts (business_id, code) WHERE is_active = true;
CREATE UNIQUE INDEX IF NOT EXISTS uq_branches_biz_code_active
  ON public.branches (business_id, code) WHERE is_active = true;
CREATE UNIQUE INDEX IF NOT EXISTS uq_analytic_accounts_biz_code_active
  ON public.analytic_accounts (business_id, code) WHERE is_active = true AND code IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_jel_biz_account
  ON public.journal_entry_lines (business_id, account_id);
CREATE INDEX IF NOT EXISTS idx_jel_business_id ON public.journal_entry_lines (business_id);
CREATE INDEX IF NOT EXISTS idx_je_biz_date ON public.journal_entries (business_id, entry_date);
CREATE INDEX IF NOT EXISTS idx_je_business_id ON public.journal_entries (business_id);
