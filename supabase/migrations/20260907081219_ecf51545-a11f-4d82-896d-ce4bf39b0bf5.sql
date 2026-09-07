-- Step 1: payments / payment_allocations still exist and are used by microfinance.
-- Move them from the (to be deleted) `sales` module onto `finance` so they keep
-- teardown/export coverage.
UPDATE public.governance_modules
SET owns_tables = owns_tables || ARRAY['payments','payment_allocations']::text[],
    updated_at = now()
WHERE module_key = 'finance'
  AND NOT ('payments' = ANY(owns_tables));

-- Step 2: register the lending module owning every mf_* table.
INSERT INTO public.governance_modules (
  module_key, display_name, description, depends_on, owns_tables,
  owns_sequences, teardown_fn, version, is_active
) VALUES (
  'lending',
  'Lending',
  'Microfinance lending domain: clients, groups, loan products, applications, loans, schedules, repayments, collections and disbursements.',
  ARRAY['finance']::text[],
  ARRAY[
    'mf_account_mappings','mf_allocation_policy','mf_application_assessments',
    'mf_clients','mf_collection_activities','mf_collection_bankings',
    'mf_event_postings','mf_group_members','mf_groups','mf_loan_applications',
    'mf_loan_charges','mf_loan_disbursements','mf_loan_events',
    'mf_loan_product_versions','mf_loan_products','mf_loan_schedule','mf_loans',
    'mf_repayment_allocations','mf_repayment_batches','mf_repayments'
  ]::text[],
  ARRAY[]::text[],
  NULL,
  1,
  true
)
ON CONFLICT (module_key) DO UPDATE
SET owns_tables = EXCLUDED.owns_tables,
    display_name = EXCLUDED.display_name,
    description = EXCLUDED.description,
    depends_on = EXCLUDED.depends_on,
    is_active = true,
    updated_at = now();

-- Step 3: delete the ERP module rows. Every table they own has already been
-- dropped from this database (verified: invoices, estimates, pos_transactions,
-- payroll_runs, timesheets, stock_movements, wms_tasks, bills, purchase_orders,
-- vendor_returns all absent).
--
-- ROLLBACK (re-seed) — uncomment to restore:
-- INSERT INTO public.governance_modules (module_key, display_name, owns_tables, teardown_fn, version, is_active)
-- VALUES ('hr','HR',ARRAY['timesheets','timesheet_submissions','timesheet_audit_log','attendance','attendance_corrections','leave_requests','leave_allocations','employee_onboarding','employee_onboarding_items','employee_loans','employee_documents','employee_benefits','contract_compensation_components']::text[],'reset_module__hr',1,true),
--        ('payroll','Payroll',ARRAY['payroll_runs','payslips','payslip_lines','payslip_inputs','payroll_periods','payroll_remittances','payroll_remittance_payments','payroll_remittance_payment_allocations','payroll_liabilities','payroll_liability_sources','payroll_payment_batches','payroll_payment_batch_items','payroll_work_entries','payroll_employee_ytd','payroll_tax_certificates','payroll_run_issues','payroll_diagnostics','payroll_return_runs']::text[],'reset_module__payroll',1,true),
--        ('pos','Point of Sale',ARRAY['pos_transactions','pos_transaction_items','pos_shifts','pos_kitchen_tickets','pos_kitchen_orders','pos_table_sessions','pos_split_bills','pos_split_bill_items','pos_held_transactions','pos_gift_card_transactions','cashier_registers']::text[],'reset_module__pos',1,true),
--        ('sales','Sales',ARRAY['invoices','invoice_items','credit_notes','credit_note_items','sales_returns','sales_return_items','delivery_notes','delivery_note_items','sales_orders','sales_order_items','proforma_invoices','proforma_invoice_items','estimates','estimate_items','recurring_invoices','recurring_invoice_items','payments','payment_allocations']::text[],'reset_module__sales',1,true),
--        ('purchases','Purchases',ARRAY['bills','bill_items','purchase_orders','purchase_order_items','bill_payments','bill_payment_allocations','expense_claims','expense_claim_items']::text[],'reset_module__purchases',1,true),
--        ('vendor_returns','Vendor Returns',ARRAY['vendor_credit_notes','vendor_credit_note_items','vendor_returns','vendor_return_items']::text[],'reset_module__vendor_returns',1,true);
DELETE FROM public.governance_modules
WHERE module_key IN (
  'hr','payroll','pos','sales','purchases','vendor_returns','inventory','warehouse'
);