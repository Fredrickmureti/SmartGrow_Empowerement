CREATE TABLE IF NOT EXISTS public.governance_modules (
  module_key             text PRIMARY KEY,
  display_name           text NOT NULL,
  description            text,
  depends_on             text[] NOT NULL DEFAULT ARRAY[]::text[],
  owns_tables            text[] NOT NULL DEFAULT ARRAY[]::text[],
  owns_storage_prefixes  jsonb  NOT NULL DEFAULT '[]'::jsonb,
  owns_sequences         text[] NOT NULL DEFAULT ARRAY[]::text[],
  derived_projections    text[] NOT NULL DEFAULT ARRAY[]::text[],
  teardown_fn            text,
  preview_fn             text,
  export_fn              text,
  version                int  NOT NULL DEFAULT 1,
  is_active              boolean NOT NULL DEFAULT true,
  registered_at          timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.governance_modules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS governance_modules_read ON public.governance_modules;
CREATE POLICY governance_modules_read
  ON public.governance_modules FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS governance_modules_no_client_write ON public.governance_modules;
CREATE POLICY governance_modules_no_client_write
  ON public.governance_modules AS RESTRICTIVE
  FOR ALL TO authenticated USING (false) WITH CHECK (false);

CREATE OR REPLACE FUNCTION public.register_governance_module(
  p_module_key            text,
  p_display_name          text,
  p_depends_on            text[]  DEFAULT ARRAY[]::text[],
  p_owns_tables           text[]  DEFAULT ARRAY[]::text[],
  p_owns_storage_prefixes jsonb   DEFAULT '[]'::jsonb,
  p_owns_sequences        text[]  DEFAULT ARRAY[]::text[],
  p_derived_projections   text[]  DEFAULT ARRAY[]::text[],
  p_teardown_fn           text    DEFAULT NULL,
  p_preview_fn            text    DEFAULT NULL,
  p_export_fn             text    DEFAULT NULL,
  p_version               int     DEFAULT 1,
  p_description           text    DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.governance_modules AS m (
    module_key, display_name, description, depends_on, owns_tables,
    owns_storage_prefixes, owns_sequences, derived_projections,
    teardown_fn, preview_fn, export_fn, version
  ) VALUES (
    p_module_key, p_display_name, p_description, p_depends_on, p_owns_tables,
    p_owns_storage_prefixes, p_owns_sequences, p_derived_projections,
    p_teardown_fn, p_preview_fn, p_export_fn, p_version
  )
  ON CONFLICT (module_key) DO UPDATE SET
    display_name          = EXCLUDED.display_name,
    description           = EXCLUDED.description,
    depends_on            = EXCLUDED.depends_on,
    owns_tables           = EXCLUDED.owns_tables,
    owns_storage_prefixes = EXCLUDED.owns_storage_prefixes,
    owns_sequences        = EXCLUDED.owns_sequences,
    derived_projections   = EXCLUDED.derived_projections,
    teardown_fn           = EXCLUDED.teardown_fn,
    preview_fn            = EXCLUDED.preview_fn,
    export_fn             = EXCLUDED.export_fn,
    version               = EXCLUDED.version,
    is_active             = true,
    updated_at            = now();
END;
$$;
REVOKE ALL ON FUNCTION public.register_governance_module(
  text,text,text[],text[],jsonb,text[],text[],text,text,text,int,text
) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.governance_list_modules()
RETURNS SETOF public.governance_modules
LANGUAGE sql STABLE SET search_path = public
AS $$ SELECT * FROM public.governance_modules WHERE is_active = true ORDER BY module_key $$;
GRANT EXECUTE ON FUNCTION public.governance_list_modules() TO authenticated;

CREATE OR REPLACE FUNCTION public.governance_list_unowned_tables()
RETURNS TABLE (table_name text)
LANGUAGE sql STABLE SET search_path = public
AS $$
  WITH org_tables AS (
    SELECT c.table_name::text AS t
    FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.column_name = 'organization_id'
  ),
  owned AS (
    SELECT unnest(owns_tables) AS t FROM public.governance_modules WHERE is_active = true
  )
  SELECT o.t FROM org_tables o WHERE o.t NOT IN (SELECT t FROM owned) ORDER BY o.t;
$$;
GRANT EXECUTE ON FUNCTION public.governance_list_unowned_tables() TO authenticated;

SELECT public.register_governance_module('sales','Sales (AR)',ARRAY['transactions_ledger']::text[],
  ARRAY['invoices','invoice_items','credit_notes','credit_note_items','sales_returns','sales_return_items','delivery_notes','delivery_note_items','sales_orders','sales_order_items','proforma_invoices','proforma_invoice_items','estimates','estimate_items','recurring_invoices','recurring_invoice_items','payments','payment_allocations']::text[],
  '[]'::jsonb, ARRAY[]::text[], ARRAY[]::text[],
  'reset_module__sales', NULL, NULL, 1,
  'Invoices, credit notes, sales returns, delivery notes, sales orders, proforma, estimates, recurring invoices, customer payments.');

SELECT public.register_governance_module('purchases','Purchases (AP)',ARRAY['transactions_ledger']::text[],
  ARRAY['bills','bill_items','purchase_orders','purchase_order_items','bill_payments','bill_payment_allocations','expense_claims','expense_claim_items']::text[],
  '[]'::jsonb, ARRAY[]::text[], ARRAY[]::text[],
  'reset_module__purchases', NULL, NULL, 1,
  'Bills, purchase orders, bill payments, expense claims.');

SELECT public.register_governance_module('vendor_returns','Vendor Returns',ARRAY['purchases']::text[],
  ARRAY['vendor_credit_notes','vendor_credit_note_items','vendor_returns','vendor_return_items']::text[],
  '[]'::jsonb, ARRAY[]::text[], ARRAY[]::text[],
  'reset_module__vendor_returns', NULL, NULL, 1, NULL);

SELECT public.register_governance_module('inventory','Inventory',ARRAY['transactions_ledger']::text[],
  ARRAY['stock_movements','stock_adjustments','stock_adjustment_items','stock_transfers','stock_transfer_items','warehouse_stock','warehouse_stock_movements']::text[],
  '[]'::jsonb, ARRAY[]::text[], ARRAY[]::text[],
  'reset_module__inventory', NULL, NULL, 1,
  'Stock movements, adjustments, transfers, warehouse stock balances.');

SELECT public.register_governance_module('pos','Point of Sale',ARRAY['sales','inventory']::text[],
  ARRAY['pos_transactions','pos_transaction_items','pos_shifts','pos_kitchen_tickets','pos_table_sessions','pos_split_bills','pos_split_bill_items','cashier_registers']::text[],
  '[]'::jsonb, ARRAY[]::text[], ARRAY[]::text[],
  'reset_module__pos', NULL, NULL, 1,
  'POS transactions, shifts, kitchen tickets, table sessions, split-bills.');

SELECT public.register_governance_module('banking','Banking',ARRAY['transactions_ledger']::text[],
  ARRAY['bank_transactions','bank_reconciliation_sessions','bank_reconciliation_items']::text[],
  '[]'::jsonb, ARRAY[]::text[], ARRAY[]::text[],
  'reset_module__banking', NULL, NULL, 1,
  'Bank transactions and reconciliation sessions.');

SELECT public.register_governance_module('finance','Finance / GL',ARRAY[]::text[],
  ARRAY['journal_entries','journal_entry_lines','analytic_distributions']::text[],
  '[]'::jsonb, ARRAY[]::text[], ARRAY['accounts.current_balance']::text[],
  'reset_module__finance', NULL, NULL, 1,
  'Journal entries, journal entry lines, fiscal period locks.');

SELECT public.register_governance_module('fixed_assets','Fixed Assets',ARRAY['finance']::text[],
  ARRAY['fixed_assets','asset_depreciation_schedules','asset_maintenance']::text[],
  '[]'::jsonb, ARRAY[]::text[], ARRAY[]::text[],
  'reset_module__fixed_assets', NULL, NULL, 1,
  'Asset register, depreciation schedules, asset maintenance.');

SELECT public.register_governance_module('transactions_ledger','Transactions Ledger Projection',ARRAY[]::text[],
  ARRAY['transactions']::text[],
  '[]'::jsonb, ARRAY[]::text[], ARRAY[]::text[],
  'reset_module__transactions_ledger', NULL, NULL, 1,
  'Cross-module transactions table projection.');

SELECT public.register_governance_module('ancillaries','Ancillary Records',ARRAY[]::text[],
  ARRAY[]::text[], '[]'::jsonb, ARRAY[]::text[], ARRAY[]::text[],
  'reset_module__ancillaries', NULL, NULL, 1,
  'Activity logs, sequences-side-data, attachments index, etc.');

SELECT public.register_governance_module('sequences','Number Sequences',ARRAY[]::text[],
  ARRAY[]::text[], '[]'::jsonb, ARRAY[]::text[], ARRAY[]::text[],
  'reset_module__sequences', NULL, NULL, 1,
  'Document numbering sequences. Reset last.');