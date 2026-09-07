CREATE OR REPLACE FUNCTION public.ensure_default_email_templates(_org_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO email_templates (organization_id, business_id, template_key, name, subject, html_body, variables)
  VALUES (
    _org_id, NULL, 'loan_approved', 'Loan Approved',
    'Your loan {{loan_number}} has been approved',
    '<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;"><h2>Loan Approved</h2><p>Dear {{client_name}},</p><p>Your loan application {{loan_number}} for {{principal}} {{currency}} has been approved.</p><p><strong>Term:</strong> {{term}}</p><p>{{notes}}</p><p>Best regards,<br>{{business_name}}</p></div>',
    '["loan_number","client_name","principal","currency","term","notes","business_name","view_link"]'::jsonb
  )
  ON CONFLICT (organization_id, template_key) WHERE business_id IS NULL DO NOTHING;

  INSERT INTO email_templates (organization_id, business_id, template_key, name, subject, html_body, variables)
  VALUES (
    _org_id, NULL, 'loan_disbursed', 'Loan Disbursed',
    'Loan {{loan_number}} has been disbursed',
    '<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;"><h2>Loan Disbursed</h2><p>Dear {{client_name}},</p><p>{{amount}} {{currency}} has been disbursed on loan {{loan_number}} on {{disbursement_date}}.</p><p>Your first instalment of {{instalment_amount}} {{currency}} falls due on {{due_date}}.</p><p>Best regards,<br>{{business_name}}</p></div>',
    '["loan_number","client_name","amount","currency","disbursement_date","instalment_amount","due_date","business_name","view_link"]'::jsonb
  )
  ON CONFLICT (organization_id, template_key) WHERE business_id IS NULL DO NOTHING;

  INSERT INTO email_templates (organization_id, business_id, template_key, name, subject, html_body, variables)
  VALUES (
    _org_id, NULL, 'repayment_receipt', 'Repayment Receipt',
    'Repayment received - Receipt {{receipt_number}}',
    '<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;"><h2>Repayment Receipt</h2><p>Dear {{client_name}},</p><p>We have received your repayment of {{amount}} {{currency}} on loan {{loan_number}}.</p><p><strong>Receipt Number:</strong> {{receipt_number}}</p><p><strong>Payment Date:</strong> {{payment_date}}</p><p><strong>Payment Method:</strong> {{payment_method}}</p><p><strong>Outstanding Balance:</strong> {{outstanding_balance}} {{currency}}</p><p>Best regards,<br>{{business_name}}</p></div>',
    '["receipt_number","client_name","loan_number","amount","currency","payment_date","payment_method","outstanding_balance","business_name"]'::jsonb
  )
  ON CONFLICT (organization_id, template_key) WHERE business_id IS NULL DO NOTHING;

  INSERT INTO email_templates (organization_id, business_id, template_key, name, subject, html_body, variables)
  VALUES (
    _org_id, NULL, 'repayment_reminder', 'Repayment Reminder',
    'Reminder: instalment on loan {{loan_number}} is due',
    '<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;"><h2>Repayment Reminder</h2><p>Dear {{client_name}},</p><p>This is a friendly reminder that your instalment of {{amount_due}} {{currency}} on loan {{loan_number}} is due on {{due_date}}.</p><p>If you have already paid, please disregard this reminder.</p><p>Best regards,<br>{{business_name}}</p></div>',
    '["loan_number","client_name","amount_due","currency","due_date","business_name","view_link"]'::jsonb
  )
  ON CONFLICT (organization_id, template_key) WHERE business_id IS NULL DO NOTHING;

  INSERT INTO email_templates (organization_id, business_id, template_key, name, subject, html_body, variables)
  VALUES (
    _org_id, NULL, 'repayment_overdue', 'Repayment Overdue',
    'OVERDUE: loan {{loan_number}} requires immediate attention',
    '<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;"><h2 style="color:#dc2626;">Repayment Overdue</h2><p>Dear {{client_name}},</p><p>The instalment of {{amount_due}} {{currency}} on loan {{loan_number}} was due on {{due_date}} and is now {{days_overdue}} days overdue.</p><p><strong>Total Arrears:</strong> {{arrears_amount}} {{currency}}</p><p>Please arrange payment at your earliest convenience, or contact your loan officer to discuss.</p><p>Best regards,<br>{{business_name}}</p></div>',
    '["loan_number","client_name","amount_due","currency","due_date","days_overdue","arrears_amount","business_name","view_link"]'::jsonb
  )
  ON CONFLICT (organization_id, template_key) WHERE business_id IS NULL DO NOTHING;
END;
$function$;

DELETE FROM public.email_templates
 WHERE template_key IN ('invoice_sent','estimate_sent','invoice_overdue','payment_reminder','payment_receipt');