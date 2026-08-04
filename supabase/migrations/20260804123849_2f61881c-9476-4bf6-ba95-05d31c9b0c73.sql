ALTER TABLE public.document_emails DROP CONSTRAINT IF EXISTS document_emails_document_type_check;
ALTER TABLE public.document_emails ADD CONSTRAINT document_emails_document_type_check CHECK (document_type = ANY (ARRAY[
  'invoice','estimate','proforma','credit_note','delivery_note','purchase_order','bill',
  'customer_statement','vendor_statement','receipt','sales_return','sales_order','report',
  'payslip','pos_receipt','contract_letter','offer_letter','promotion_letter','warning_letter'
]));