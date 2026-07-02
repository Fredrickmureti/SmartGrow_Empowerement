
ALTER TABLE public.invoices            ADD COLUMN IF NOT EXISTS is_sample_data boolean NOT NULL DEFAULT false;
ALTER TABLE public.invoice_items       ADD COLUMN IF NOT EXISTS is_sample_data boolean NOT NULL DEFAULT false;
ALTER TABLE public.bills               ADD COLUMN IF NOT EXISTS is_sample_data boolean NOT NULL DEFAULT false;
ALTER TABLE public.bill_items          ADD COLUMN IF NOT EXISTS is_sample_data boolean NOT NULL DEFAULT false;
ALTER TABLE public.bill_payments       ADD COLUMN IF NOT EXISTS is_sample_data boolean NOT NULL DEFAULT false;
ALTER TABLE public.payments            ADD COLUMN IF NOT EXISTS is_sample_data boolean NOT NULL DEFAULT false;
ALTER TABLE public.payment_allocations ADD COLUMN IF NOT EXISTS is_sample_data boolean NOT NULL DEFAULT false;
ALTER TABLE public.credit_notes        ADD COLUMN IF NOT EXISTS is_sample_data boolean NOT NULL DEFAULT false;
ALTER TABLE public.credit_note_items   ADD COLUMN IF NOT EXISTS is_sample_data boolean NOT NULL DEFAULT false;
ALTER TABLE public.credit_note_applications ADD COLUMN IF NOT EXISTS is_sample_data boolean NOT NULL DEFAULT false;
ALTER TABLE public.vendor_credit_notes      ADD COLUMN IF NOT EXISTS is_sample_data boolean NOT NULL DEFAULT false;
ALTER TABLE public.vendor_credit_note_items ADD COLUMN IF NOT EXISTS is_sample_data boolean NOT NULL DEFAULT false;
ALTER TABLE public.vendor_credit_note_applications ADD COLUMN IF NOT EXISTS is_sample_data boolean NOT NULL DEFAULT false;
ALTER TABLE public.estimates           ADD COLUMN IF NOT EXISTS is_sample_data boolean NOT NULL DEFAULT false;
ALTER TABLE public.estimate_items      ADD COLUMN IF NOT EXISTS is_sample_data boolean NOT NULL DEFAULT false;
ALTER TABLE public.proforma_invoices       ADD COLUMN IF NOT EXISTS is_sample_data boolean NOT NULL DEFAULT false;
ALTER TABLE public.proforma_invoice_items  ADD COLUMN IF NOT EXISTS is_sample_data boolean NOT NULL DEFAULT false;
ALTER TABLE public.sales_orders        ADD COLUMN IF NOT EXISTS is_sample_data boolean NOT NULL DEFAULT false;
ALTER TABLE public.sales_order_items   ADD COLUMN IF NOT EXISTS is_sample_data boolean NOT NULL DEFAULT false;
ALTER TABLE public.delivery_notes      ADD COLUMN IF NOT EXISTS is_sample_data boolean NOT NULL DEFAULT false;
ALTER TABLE public.delivery_note_items ADD COLUMN IF NOT EXISTS is_sample_data boolean NOT NULL DEFAULT false;
ALTER TABLE public.sales_returns       ADD COLUMN IF NOT EXISTS is_sample_data boolean NOT NULL DEFAULT false;
ALTER TABLE public.sales_return_items  ADD COLUMN IF NOT EXISTS is_sample_data boolean NOT NULL DEFAULT false;
ALTER TABLE public.recurring_invoices  ADD COLUMN IF NOT EXISTS is_sample_data boolean NOT NULL DEFAULT false;
ALTER TABLE public.purchase_orders     ADD COLUMN IF NOT EXISTS is_sample_data boolean NOT NULL DEFAULT false;
ALTER TABLE public.purchase_order_items ADD COLUMN IF NOT EXISTS is_sample_data boolean NOT NULL DEFAULT false;
ALTER TABLE public.expenses            ADD COLUMN IF NOT EXISTS is_sample_data boolean NOT NULL DEFAULT false;
ALTER TABLE public.journal_entries     ADD COLUMN IF NOT EXISTS is_sample_data boolean NOT NULL DEFAULT false;
ALTER TABLE public.journal_entry_lines ADD COLUMN IF NOT EXISTS is_sample_data boolean NOT NULL DEFAULT false;
ALTER TABLE public.bank_transactions   ADD COLUMN IF NOT EXISTS is_sample_data boolean NOT NULL DEFAULT false;
ALTER TABLE public.products            ADD COLUMN IF NOT EXISTS is_sample_data boolean NOT NULL DEFAULT false;
ALTER TABLE public.contacts            ADD COLUMN IF NOT EXISTS is_sample_data boolean NOT NULL DEFAULT false;
ALTER TABLE public.bank_reconciliation_sessions ADD COLUMN IF NOT EXISTS is_sample_data boolean NOT NULL DEFAULT false;
ALTER TABLE public.bank_reconciliation_items    ADD COLUMN IF NOT EXISTS is_sample_data boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_invoices_is_sample        ON public.invoices(organization_id) WHERE is_sample_data = true;
CREATE INDEX IF NOT EXISTS idx_bills_is_sample           ON public.bills(organization_id) WHERE is_sample_data = true;
CREATE INDEX IF NOT EXISTS idx_payments_is_sample        ON public.payments(organization_id) WHERE is_sample_data = true;
CREATE INDEX IF NOT EXISTS idx_credit_notes_is_sample    ON public.credit_notes(organization_id) WHERE is_sample_data = true;
CREATE INDEX IF NOT EXISTS idx_estimates_is_sample       ON public.estimates(organization_id) WHERE is_sample_data = true;
CREATE INDEX IF NOT EXISTS idx_sales_orders_is_sample    ON public.sales_orders(organization_id) WHERE is_sample_data = true;
CREATE INDEX IF NOT EXISTS idx_delivery_notes_is_sample  ON public.delivery_notes(organization_id) WHERE is_sample_data = true;
CREATE INDEX IF NOT EXISTS idx_sales_returns_is_sample   ON public.sales_returns(organization_id) WHERE is_sample_data = true;
CREATE INDEX IF NOT EXISTS idx_proforma_is_sample        ON public.proforma_invoices(organization_id) WHERE is_sample_data = true;
CREATE INDEX IF NOT EXISTS idx_recurring_is_sample       ON public.recurring_invoices(organization_id) WHERE is_sample_data = true;
CREATE INDEX IF NOT EXISTS idx_expenses_is_sample        ON public.expenses(organization_id) WHERE is_sample_data = true;
CREATE INDEX IF NOT EXISTS idx_je_is_sample              ON public.journal_entries(organization_id) WHERE is_sample_data = true;
CREATE INDEX IF NOT EXISTS idx_bank_tx_is_sample         ON public.bank_transactions(organization_id) WHERE is_sample_data = true;
CREATE INDEX IF NOT EXISTS idx_products_is_sample        ON public.products(organization_id) WHERE is_sample_data = true;
CREATE INDEX IF NOT EXISTS idx_contacts_is_sample        ON public.contacts(organization_id) WHERE is_sample_data = true;

CREATE OR REPLACE FUNCTION public.get_sample_data_counts(org_id uuid)
RETURNS TABLE(table_name text, sample_count bigint, total_count bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_org_member(auth.uid(), org_id) THEN
    RAISE EXCEPTION 'Not authorized for organization %', org_id USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT 'contacts'::text,
    (SELECT count(*) FROM contacts WHERE organization_id = org_id AND is_sample_data),
    (SELECT count(*) FROM contacts WHERE organization_id = org_id)
  UNION ALL SELECT 'products',
    (SELECT count(*) FROM products WHERE organization_id = org_id AND is_sample_data),
    (SELECT count(*) FROM products WHERE organization_id = org_id)
  UNION ALL SELECT 'invoices',
    (SELECT count(*) FROM invoices WHERE organization_id = org_id AND is_sample_data),
    (SELECT count(*) FROM invoices WHERE organization_id = org_id)
  UNION ALL SELECT 'bills',
    (SELECT count(*) FROM bills WHERE organization_id = org_id AND is_sample_data),
    (SELECT count(*) FROM bills WHERE organization_id = org_id)
  UNION ALL SELECT 'expenses',
    (SELECT count(*) FROM expenses WHERE organization_id = org_id AND is_sample_data),
    (SELECT count(*) FROM expenses WHERE organization_id = org_id)
  UNION ALL SELECT 'estimates',
    (SELECT count(*) FROM estimates WHERE organization_id = org_id AND is_sample_data),
    (SELECT count(*) FROM estimates WHERE organization_id = org_id)
  UNION ALL SELECT 'proforma_invoices',
    (SELECT count(*) FROM proforma_invoices WHERE organization_id = org_id AND is_sample_data),
    (SELECT count(*) FROM proforma_invoices WHERE organization_id = org_id)
  UNION ALL SELECT 'sales_orders',
    (SELECT count(*) FROM sales_orders WHERE organization_id = org_id AND is_sample_data),
    (SELECT count(*) FROM sales_orders WHERE organization_id = org_id)
  UNION ALL SELECT 'delivery_notes',
    (SELECT count(*) FROM delivery_notes WHERE organization_id = org_id AND is_sample_data),
    (SELECT count(*) FROM delivery_notes WHERE organization_id = org_id)
  UNION ALL SELECT 'sales_returns',
    (SELECT count(*) FROM sales_returns WHERE organization_id = org_id AND is_sample_data),
    (SELECT count(*) FROM sales_returns WHERE organization_id = org_id)
  UNION ALL SELECT 'recurring_invoices',
    (SELECT count(*) FROM recurring_invoices WHERE organization_id = org_id AND is_sample_data),
    (SELECT count(*) FROM recurring_invoices WHERE organization_id = org_id)
  UNION ALL SELECT 'credit_notes',
    (SELECT count(*) FROM credit_notes WHERE organization_id = org_id AND is_sample_data),
    (SELECT count(*) FROM credit_notes WHERE organization_id = org_id)
  UNION ALL SELECT 'payments',
    (SELECT count(*) FROM payments WHERE organization_id = org_id AND is_sample_data),
    (SELECT count(*) FROM payments WHERE organization_id = org_id)
  UNION ALL SELECT 'bill_payments',
    (SELECT count(*) FROM bill_payments WHERE organization_id = org_id AND is_sample_data),
    (SELECT count(*) FROM bill_payments WHERE organization_id = org_id)
  UNION ALL SELECT 'purchase_orders',
    (SELECT count(*) FROM purchase_orders WHERE organization_id = org_id AND is_sample_data),
    (SELECT count(*) FROM purchase_orders WHERE organization_id = org_id)
  UNION ALL SELECT 'journal_entries',
    (SELECT count(*) FROM journal_entries WHERE organization_id = org_id AND is_sample_data),
    (SELECT count(*) FROM journal_entries WHERE organization_id = org_id)
  UNION ALL SELECT 'bank_transactions',
    (SELECT count(*) FROM bank_transactions WHERE organization_id = org_id AND is_sample_data),
    (SELECT count(*) FROM bank_transactions WHERE organization_id = org_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.clear_sample_data(org_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_total bigint := 0;
  v_counts jsonb := '{}'::jsonb;
  v_n bigint;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE='42501';
  END IF;

  IF NOT (
    public.has_role(v_user, org_id, 'super_admin'::app_role)
    OR public.has_role(v_user, org_id, 'owner'::app_role)
    OR public.has_role(v_user, org_id, 'admin'::app_role)
  ) THEN
    RAISE EXCEPTION 'Insufficient permissions: admin/owner required' USING ERRCODE='42501';
  END IF;

  WITH d AS (DELETE FROM bank_reconciliation_items WHERE is_sample_data RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('bank_reconciliation_items', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM bank_reconciliation_sessions WHERE organization_id=org_id AND is_sample_data RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('bank_reconciliation_sessions', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM payment_allocations WHERE is_sample_data RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('payment_allocations', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM bill_payments WHERE organization_id=org_id AND is_sample_data RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('bill_payments', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM payments WHERE organization_id=org_id AND is_sample_data RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('payments', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM credit_note_applications WHERE is_sample_data RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('credit_note_applications', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM credit_note_items WHERE credit_note_id IN (SELECT id FROM credit_notes WHERE organization_id=org_id AND is_sample_data) RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('credit_note_items', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM credit_notes WHERE organization_id=org_id AND is_sample_data RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('credit_notes', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM vendor_credit_note_applications WHERE is_sample_data RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('vendor_credit_note_applications', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM vendor_credit_note_items WHERE is_sample_data RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('vendor_credit_note_items', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM vendor_credit_notes WHERE is_sample_data RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('vendor_credit_notes', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM sales_return_items WHERE sales_return_id IN (SELECT id FROM sales_returns WHERE organization_id=org_id AND is_sample_data) RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('sales_return_items', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM sales_returns WHERE organization_id=org_id AND is_sample_data RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('sales_returns', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM delivery_note_items WHERE delivery_note_id IN (SELECT id FROM delivery_notes WHERE organization_id=org_id AND is_sample_data) RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('delivery_note_items', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM delivery_notes WHERE organization_id=org_id AND is_sample_data RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('delivery_notes', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM invoice_items WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id=org_id AND is_sample_data) RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('invoice_items', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM invoices WHERE organization_id=org_id AND is_sample_data RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('invoices', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM bill_items WHERE bill_id IN (SELECT id FROM bills WHERE organization_id=org_id AND is_sample_data) RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('bill_items', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM bills WHERE organization_id=org_id AND is_sample_data RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('bills', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM purchase_order_items WHERE purchase_order_id IN (SELECT id FROM purchase_orders WHERE organization_id=org_id AND is_sample_data) RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('purchase_order_items', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM purchase_orders WHERE organization_id=org_id AND is_sample_data RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('purchase_orders', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM sales_order_items WHERE sales_order_id IN (SELECT id FROM sales_orders WHERE organization_id=org_id AND is_sample_data) RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('sales_order_items', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM sales_orders WHERE organization_id=org_id AND is_sample_data RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('sales_orders', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM proforma_invoice_items WHERE proforma_invoice_id IN (SELECT id FROM proforma_invoices WHERE organization_id=org_id AND is_sample_data) RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('proforma_invoice_items', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM proforma_invoices WHERE organization_id=org_id AND is_sample_data RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('proforma_invoices', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM estimate_items WHERE estimate_id IN (SELECT id FROM estimates WHERE organization_id=org_id AND is_sample_data) RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('estimate_items', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM estimates WHERE organization_id=org_id AND is_sample_data RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('estimates', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM recurring_invoices WHERE organization_id=org_id AND is_sample_data RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('recurring_invoices', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM expenses WHERE organization_id=org_id AND is_sample_data RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('expenses', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM journal_entry_lines WHERE journal_entry_id IN (SELECT id FROM journal_entries WHERE organization_id=org_id AND is_sample_data) RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('journal_entry_lines', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM journal_entries WHERE organization_id=org_id AND is_sample_data RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('journal_entries', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM bank_transactions WHERE organization_id=org_id AND is_sample_data RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('bank_transactions', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM products WHERE organization_id=org_id AND is_sample_data RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('products', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM contacts WHERE organization_id=org_id AND is_sample_data RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('contacts', v_n); v_total := v_total + v_n;

  RETURN jsonb_build_object('success', true, 'totalDeleted', v_total, 'details', v_counts);
END;
$$;

CREATE OR REPLACE FUNCTION public.reset_organization_data(org_id uuid, confirmation_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_total bigint := 0;
  v_counts jsonb := '{}'::jsonb;
  v_n bigint;
  v_expected_token text;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE='42501';
  END IF;

  IF NOT (
    public.has_role(v_user, org_id, 'super_admin'::app_role)
    OR public.has_role(v_user, org_id, 'owner'::app_role)
  ) THEN
    RAISE EXCEPTION 'Insufficient permissions: owner required for reset' USING ERRCODE='42501';
  END IF;

  v_expected_token := 'RESET-' || org_id::text;
  IF confirmation_token IS DISTINCT FROM v_expected_token THEN
    RAISE EXCEPTION 'Invalid confirmation token' USING ERRCODE='22023';
  END IF;

  WITH d AS (DELETE FROM bank_reconciliation_items WHERE session_id IN (SELECT id FROM bank_reconciliation_sessions WHERE organization_id=org_id) RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('bank_reconciliation_items', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM bank_reconciliation_sessions WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('bank_reconciliation_sessions', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM payment_allocations WHERE payment_id IN (SELECT id FROM payments WHERE organization_id=org_id) OR payment_id IN (SELECT id FROM bill_payments WHERE organization_id=org_id) RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('payment_allocations', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM bill_payments WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('bill_payments', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM payments WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('payments', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM credit_note_applications WHERE credit_note_id IN (SELECT id FROM credit_notes WHERE organization_id=org_id) RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('credit_note_applications', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM credit_note_items WHERE credit_note_id IN (SELECT id FROM credit_notes WHERE organization_id=org_id) RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('credit_note_items', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM credit_notes WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('credit_notes', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM sales_return_items WHERE sales_return_id IN (SELECT id FROM sales_returns WHERE organization_id=org_id) RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('sales_return_items', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM sales_returns WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('sales_returns', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM delivery_note_items WHERE delivery_note_id IN (SELECT id FROM delivery_notes WHERE organization_id=org_id) RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('delivery_note_items', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM delivery_notes WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('delivery_notes', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM invoice_items WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id=org_id) RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('invoice_items', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM invoices WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('invoices', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM bill_items WHERE bill_id IN (SELECT id FROM bills WHERE organization_id=org_id) RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('bill_items', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM bills WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('bills', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM purchase_order_items WHERE purchase_order_id IN (SELECT id FROM purchase_orders WHERE organization_id=org_id) RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('purchase_order_items', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM purchase_orders WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('purchase_orders', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM sales_order_items WHERE sales_order_id IN (SELECT id FROM sales_orders WHERE organization_id=org_id) RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('sales_order_items', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM sales_orders WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('sales_orders', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM proforma_invoice_items WHERE proforma_invoice_id IN (SELECT id FROM proforma_invoices WHERE organization_id=org_id) RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('proforma_invoice_items', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM proforma_invoices WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('proforma_invoices', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM estimate_items WHERE estimate_id IN (SELECT id FROM estimates WHERE organization_id=org_id) RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('estimate_items', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM estimates WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('estimates', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM recurring_invoices WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('recurring_invoices', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM expenses WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('expenses', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM journal_entry_lines WHERE journal_entry_id IN (SELECT id FROM journal_entries WHERE organization_id=org_id) RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('journal_entry_lines', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM journal_entries WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('journal_entries', v_n); v_total := v_total + v_n;

  WITH d AS (DELETE FROM bank_transactions WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO v_n FROM d;
  v_counts := v_counts || jsonb_build_object('bank_transactions', v_n); v_total := v_total + v_n;

  RETURN jsonb_build_object('success', true, 'totalDeleted', v_total, 'details', v_counts);
END;
$$;

REVOKE ALL ON FUNCTION public.clear_sample_data(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reset_organization_data(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.clear_sample_data(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reset_organization_data(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_sample_data_counts(uuid) TO authenticated;
