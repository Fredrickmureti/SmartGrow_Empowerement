-- Update the notify_payment_received function to use correct route
CREATE OR REPLACE FUNCTION public.notify_payment_received()
RETURNS trigger
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
    
    -- Get all users in the organization
    SELECT ARRAY_AGG(user_id) INTO org_users
    FROM user_organizations
    WHERE organization_id = invoice_record.organization_id;

    -- Create notification for each user
    IF org_users IS NOT NULL THEN
      INSERT INTO notifications (user_id, category, title, message, link, organization_id)
      SELECT 
        unnest(org_users),
        'payment',
        'Payment Received',
        'Payment of ' || NEW.amount::TEXT || ' received for invoice ' || invoice_record.invoice_number,
        '/customer-payments',  -- Fixed: was '/payments' which doesn't exist
        invoice_record.organization_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- Also fix existing notifications with the wrong link
UPDATE notifications 
SET link = '/customer-payments' 
WHERE link = '/payments';