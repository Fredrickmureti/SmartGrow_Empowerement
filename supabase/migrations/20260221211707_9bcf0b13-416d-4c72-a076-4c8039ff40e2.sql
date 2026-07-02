
-- Fix notify_payment_received to use app-based route /sales/payments
CREATE OR REPLACE FUNCTION public.notify_payment_received()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  invoice_record RECORD;
  customer_name TEXT;
  org_users UUID[];
BEGIN
  SELECT i.invoice_number, i.organization_id, c.name
  INTO invoice_record
  FROM invoices i
  LEFT JOIN contacts c ON i.contact_id = c.id
  WHERE i.id = NEW.invoice_id;

  IF invoice_record IS NOT NULL THEN
    customer_name := COALESCE(invoice_record.name, 'Customer');
    
    SELECT ARRAY_AGG(user_id) INTO org_users
    FROM user_roles
    WHERE organization_id = invoice_record.organization_id
      AND is_active = true;

    IF org_users IS NOT NULL THEN
      INSERT INTO notifications (user_id, category, title, message, link, organization_id)
      SELECT 
        unnest(org_users),
        'payment',
        'Payment Received',
        'Payment of ' || NEW.amount::TEXT || ' received for invoice ' || invoice_record.invoice_number,
        '/sales/payments',
        invoice_record.organization_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- Fix all existing payment notifications with legacy route
UPDATE notifications 
SET link = '/sales/payments' 
WHERE link = '/customer-payments';
