-- 1. AR/sales reporting views
DROP VIEW IF EXISTS public.finance_open_items_tieout CASCADE;
DROP VIEW IF EXISTS public.finance_ar_net_position_by_currency CASCADE;
DROP VIEW IF EXISTS public.finance_ar_net_position CASCADE;
DROP VIEW IF EXISTS public.finance_ar_open_items CASCADE;
DROP VIEW IF EXISTS public.finance_ar_customer_credit CASCADE;
DROP VIEW IF EXISTS public.customer_credit_tieout CASCADE;
DROP VIEW IF EXISTS public.customer_ledger_entries CASCADE;
DROP VIEW IF EXISTS public.ar_subledger_entries CASCADE;
DROP VIEW IF EXISTS public.v_invoice_creditable_qty CASCADE;
DROP VIEW IF EXISTS public.v_sales_return_settlement CASCADE;
DROP VIEW IF EXISTS public.v_sales_returnable_qty CASCADE;

-- 2. Detach retained tables from the sales chain
ALTER TABLE public.payments                DROP COLUMN IF EXISTS invoice_id CASCADE;
ALTER TABLE public.payment_allocations     DROP COLUMN IF EXISTS invoice_id CASCADE;
ALTER TABLE public.mpesa_c2b_transactions  DROP COLUMN IF EXISTS matched_invoice_id CASCADE;
ALTER TABLE public.transactions            DROP COLUMN IF EXISTS invoice_id CASCADE;
ALTER TABLE public.delivery_notes          DROP COLUMN IF EXISTS source_invoice_id CASCADE;
ALTER TABLE public.delivery_notes          DROP COLUMN IF EXISTS spawned_invoice_id CASCADE;
ALTER TABLE public.sales_orders            DROP COLUMN IF EXISTS source_estimate_id CASCADE;
ALTER TABLE public.sales_orders            DROP COLUMN IF EXISTS converted_invoice_id CASCADE;
ALTER TABLE public.sales_returns           DROP COLUMN IF EXISTS invoice_id CASCADE;
ALTER TABLE public.sales_returns           DROP COLUMN IF EXISTS credit_note_id CASCADE;
ALTER TABLE public.sales_return_items      DROP COLUMN IF EXISTS invoice_item_id CASCADE;
ALTER TABLE public.recurring_invoice_runs  DROP COLUMN IF EXISTS invoice_id CASCADE;

-- 3. Drop the sales / receivables chain
DROP TABLE IF EXISTS public.ar_promises_to_pay CASCADE;
DROP TABLE IF EXISTS public.ar_disputes CASCADE;
DROP TABLE IF EXISTS public.dunning_levels CASCADE;
DROP TABLE IF EXISTS public.customer_statement_send_jobs CASCADE;
DROP TABLE IF EXISTS public.customer_statements CASCADE;
DROP TABLE IF EXISTS public.customer_refunds CASCADE;
DROP TABLE IF EXISTS public.customer_credit_movements CASCADE;
DROP TABLE IF EXISTS public.customer_credit_balances CASCADE;
DROP TABLE IF EXISTS public.credit_note_applications CASCADE;
DROP TABLE IF EXISTS public.credit_note_items CASCADE;
DROP TABLE IF EXISTS public.credit_notes CASCADE;
DROP TABLE IF EXISTS public.proforma_invoice_items CASCADE;
DROP TABLE IF EXISTS public.proforma_invoices CASCADE;
DROP TABLE IF EXISTS public.estimate_status_events CASCADE;
DROP TABLE IF EXISTS public.estimate_additional_costs CASCADE;
DROP TABLE IF EXISTS public.estimate_items CASCADE;
DROP TABLE IF EXISTS public.estimates CASCADE;
DROP TABLE IF EXISTS public.invoice_additional_costs CASCADE;
DROP TABLE IF EXISTS public.invoice_items CASCADE;
DROP TABLE IF EXISTS public.invoices CASCADE;