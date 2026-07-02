CREATE OR REPLACE FUNCTION public.ensure_default_email_templates(_org_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO email_templates (organization_id, business_id, template_key, name, subject, html_body, variables)
  VALUES (
    _org_id, NULL, 'invoice_sent', 'Invoice Sent',
    'Invoice {{invoice_number}} from {{business_name}}',
    '<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;"><h2>Invoice {{invoice_number}}</h2><p>Dear {{customer_name}},</p><p>Please find attached invoice {{invoice_number}} for {{total}} {{currency}}.</p><p><strong>Due Date:</strong> {{due_date}}</p><p>{{notes}}</p><p>Thank you for your business!</p><p>Best regards,<br>{{business_name}}</p></div>',
    '["invoice_number","customer_name","total","currency","due_date","notes","business_name","view_link"]'::jsonb
  )
  ON CONFLICT (organization_id, template_key) WHERE business_id IS NULL DO NOTHING;

  INSERT INTO email_templates (organization_id, business_id, template_key, name, subject, html_body, variables)
  VALUES (
    _org_id, NULL, 'payment_reminder', 'Payment Reminder',
    'Reminder: Invoice {{invoice_number}} is due',
    '<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;"><h2>Payment Reminder</h2><p>Dear {{customer_name}},</p><p>This is a friendly reminder that invoice {{invoice_number}} for {{total}} {{currency}} is due on {{due_date}}.</p><p>If you have already made the payment, please disregard this reminder.</p><p>Best regards,<br>{{business_name}}</p></div>',
    '["invoice_number","customer_name","total","currency","due_date","business_name","view_link"]'::jsonb
  )
  ON CONFLICT (organization_id, template_key) WHERE business_id IS NULL DO NOTHING;

  INSERT INTO email_templates (organization_id, business_id, template_key, name, subject, html_body, variables)
  VALUES (
    _org_id, NULL, 'payment_receipt', 'Payment Receipt',
    'Payment Received - Receipt {{receipt_number}}',
    '<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;"><h2>Payment Receipt</h2><p>Dear {{customer_name}},</p><p>We have received your payment of {{amount}} {{currency}}.</p><p><strong>Receipt Number:</strong> {{receipt_number}}</p><p><strong>Payment Date:</strong> {{payment_date}}</p><p><strong>Payment Method:</strong> {{payment_method}}</p><p>Thank you for your payment!</p><p>Best regards,<br>{{business_name}}</p></div>',
    '["receipt_number","customer_name","amount","currency","payment_date","payment_method","business_name"]'::jsonb
  )
  ON CONFLICT (organization_id, template_key) WHERE business_id IS NULL DO NOTHING;

  INSERT INTO email_templates (organization_id, business_id, template_key, name, subject, html_body, variables)
  VALUES (
    _org_id, NULL, 'estimate_sent', 'Estimate Sent',
    'Estimate {{estimate_number}} from {{business_name}}',
    '<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;"><h2>Estimate {{estimate_number}}</h2><p>Dear {{customer_name}},</p><p>Please find attached estimate {{estimate_number}} for {{total}} {{currency}}.</p><p><strong>Valid Until:</strong> {{valid_until}}</p><p>{{notes}}</p><p>Please let us know if you have any questions.</p><p>Best regards,<br>{{business_name}}</p></div>',
    '["estimate_number","customer_name","total","currency","valid_until","notes","business_name","view_link"]'::jsonb
  )
  ON CONFLICT (organization_id, template_key) WHERE business_id IS NULL DO NOTHING;

  INSERT INTO email_templates (organization_id, business_id, template_key, name, subject, html_body, variables)
  VALUES (
    _org_id, NULL, 'invoice_overdue', 'Invoice Overdue',
    'OVERDUE: Invoice {{invoice_number}} requires immediate attention',
    '<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;"><h2 style="color:#dc2626;">Invoice Overdue</h2><p>Dear {{customer_name}},</p><p>Invoice {{invoice_number}} for {{total}} {{currency}} was due on {{due_date}} and is now {{days_overdue}} days overdue.</p><p><strong>Amount Due:</strong> {{balance_due}} {{currency}}</p><p>Please arrange payment at your earliest convenience to avoid any service interruptions.</p><p>If you have any questions or need to discuss payment arrangements, please contact us.</p><p>Best regards,<br>{{business_name}}</p></div>',
    '["invoice_number","customer_name","total","currency","due_date","days_overdue","balance_due","business_name","view_link"]'::jsonb
  )
  ON CONFLICT (organization_id, template_key) WHERE business_id IS NULL DO NOTHING;
END;
$$;