-- Fix the notify_payment_received function to use the correct table name
-- The function was referencing 'user_organizations' which doesn't exist
-- The correct table is 'user_roles'

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
  -- Get invoice details
  SELECT i.invoice_number, i.organization_id, c.name
  INTO invoice_record
  FROM invoices i
  LEFT JOIN contacts c ON i.contact_id = c.id
  WHERE i.id = NEW.invoice_id;

  IF invoice_record IS NOT NULL THEN
    customer_name := COALESCE(invoice_record.name, 'Customer');
    
    -- Get all active users in the organization from user_roles table
    SELECT ARRAY_AGG(user_id) INTO org_users
    FROM user_roles
    WHERE organization_id = invoice_record.organization_id
      AND is_active = true;

    -- Create notification for each user
    IF org_users IS NOT NULL THEN
      INSERT INTO notifications (user_id, category, title, message, link, organization_id)
      SELECT 
        unnest(org_users),
        'payment',
        'Payment Received',
        'Payment of ' || NEW.amount::TEXT || ' received for invoice ' || invoice_record.invoice_number,
        '/customer-payments',
        invoice_record.organization_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;