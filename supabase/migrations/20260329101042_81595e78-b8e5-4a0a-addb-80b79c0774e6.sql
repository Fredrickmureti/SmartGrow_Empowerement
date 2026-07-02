
DO $$
DECLARE
  tbl TEXT;
  tables_to_truncate TEXT[] := ARRAY[
    'migration_batches','migration_steps','migration_sessions',
    'journal_entry_lines','journal_entries','je_number_sequences',
    'invoice_activities','invoice_additional_costs','invoice_emails','invoice_items',
    'invoice_reminders','invoice_sequences','credit_note_applications','credit_note_items','credit_notes',
    'payments','payment_allocations','invoices',
    'bill_items','bill_payments','bills',
    'expenses','expense_categories',
    'estimate_additional_costs','estimate_items','estimates',
    'backorders','delivery_note_items','delivery_notes',
    'goods_receipt_items','goods_receipts',
    'sales_order_items','sales_orders',
    'purchase_order_items','purchase_orders',
    'stock_movements','product_categories','products',
    'contact_addresses','customer_groups','customer_loyalty','customer_statements','contacts',
    'bank_reconciliation_items','bank_reconciliation_sessions',
    'bank_transaction_splits','bank_transactions','bank_statements','bank_accounts',
    'reconciliation_sessions',
    'default_account_mappings','default_account_settings',
    'analytic_distributions','analytic_accounts','analytic_groups',
    'accounts',
    'asset_maintenance','depreciation_entries','depreciation_schedules','fixed_assets','asset_categories',
    'budget_actuals','budget_items','budgets',
    'fiscal_periods','tax_rates',
    'audit_logs','notifications','notification_digest_queue'
  ];
BEGIN
  FOREACH tbl IN ARRAY tables_to_truncate LOOP
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = tbl) THEN
      EXECUTE format('TRUNCATE TABLE public.%I CASCADE', tbl);
    END IF;
  END LOOP;
END $$;
