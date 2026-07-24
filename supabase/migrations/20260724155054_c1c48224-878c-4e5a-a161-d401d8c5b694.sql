
INSERT INTO public.legal_order_statutory_report_definitions
  (organization_id, jurisdiction_code, report_code, name, description, frequency, is_active, definition)
SELECT NULL, '*', 'legal_orders_outstanding_by_recipient',
       'Legal Orders — Outstanding by Recipient',
       'Aggregate view of open legal orders grouped by recipient with total owed, accrued, remitted and outstanding balances.',
       'monthly', true,
       jsonb_build_object(
         'source', 'legal_recipient_outstanding',
         'group_by', jsonb_build_array('recipient_id'),
         'columns', jsonb_build_array(
           'recipient_name','jurisdiction_country','orders_open',
           'total_owed','accrued','remitted','outstanding'
         ),
         'filters', jsonb_build_object('include_zero_outstanding', false),
         'order_by', jsonb_build_array(jsonb_build_object('field','outstanding','dir','desc'))
       )
WHERE NOT EXISTS (
  SELECT 1 FROM public.legal_order_statutory_report_definitions
   WHERE organization_id IS NULL AND jurisdiction_code = '*'
     AND report_code = 'legal_orders_outstanding_by_recipient'
);

INSERT INTO public.legal_order_statutory_report_definitions
  (organization_id, jurisdiction_code, report_code, name, description, frequency, is_active, definition)
SELECT NULL, '*', 'legal_orders_remittance_activity',
       'Legal Orders — Remittance Activity',
       'Settled remittance batches in the reporting period, with planned vs actual totals and bank-reconciliation status per batch.',
       'monthly', true,
       jsonb_build_object(
         'source', 'legal_order_remittance_batches',
         'joins', jsonb_build_array(
           jsonb_build_object('table','legal_order_remittance_batch_lines','on','batch_id')
         ),
         'filters', jsonb_build_object('status','settled','period_field','settled_payment_date'),
         'columns', jsonb_build_array(
           'batch_number','recipient_id','recipient_name',
           'settled_payment_date','planned_total','actual_total',
           'settled_bank_transaction_id','bank_txn_matched'
         ),
         'order_by', jsonb_build_array(jsonb_build_object('field','settled_payment_date','dir','asc'))
       )
WHERE NOT EXISTS (
  SELECT 1 FROM public.legal_order_statutory_report_definitions
   WHERE organization_id IS NULL AND jurisdiction_code = '*'
     AND report_code = 'legal_orders_remittance_activity'
);
