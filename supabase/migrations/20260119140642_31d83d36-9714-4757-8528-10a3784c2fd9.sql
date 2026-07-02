-- Fix function search_path for security
-- Update all notification-related functions with proper search_path

CREATE OR REPLACE FUNCTION public.update_notification_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
SET search_path = public;

CREATE OR REPLACE FUNCTION public.create_notification(
  p_organization_id UUID,
  p_user_id UUID,
  p_type VARCHAR(50),
  p_category VARCHAR(50),
  p_title VARCHAR(255),
  p_message TEXT,
  p_link VARCHAR(500) DEFAULT NULL,
  p_entity_type VARCHAR(50) DEFAULT NULL,
  p_entity_id UUID DEFAULT NULL,
  p_priority INTEGER DEFAULT 0,
  p_business_id UUID DEFAULT NULL
)
RETURNS UUID AS $$
DECLARE
  v_notification_id UUID;
  v_in_app_enabled BOOLEAN;
BEGIN
  -- Check user preferences
  SELECT in_app_enabled INTO v_in_app_enabled
  FROM public.notification_preferences
  WHERE user_id = p_user_id 
    AND organization_id = p_organization_id 
    AND category = p_category;
  
  -- Default to true if no preference exists
  IF v_in_app_enabled IS NULL THEN
    v_in_app_enabled := TRUE;
  END IF;
  
  -- Only create if in-app is enabled
  IF v_in_app_enabled THEN
    INSERT INTO public.notifications (
      organization_id, business_id, user_id, type, category, 
      title, message, link, entity_type, entity_id, priority
    ) VALUES (
      p_organization_id, p_business_id, p_user_id, p_type, p_category,
      p_title, p_message, p_link, p_entity_type, p_entity_id, p_priority
    )
    RETURNING id INTO v_notification_id;
  END IF;
  
  RETURN v_notification_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public;

CREATE OR REPLACE FUNCTION public.check_overdue_invoices()
RETURNS void AS $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN 
    SELECT i.id, i.invoice_number, i.organization_id, i.business_id, i.due_date,
           ur.user_id
    FROM public.invoices i
    JOIN public.user_roles ur ON ur.organization_id = i.organization_id AND ur.is_active = true
    WHERE i.status IN ('sent', 'overdue')
      AND i.due_date < CURRENT_DATE
      AND NOT EXISTS (
        SELECT 1 FROM public.notifications n 
        WHERE n.entity_id = i.id 
          AND n.entity_type = 'invoice_overdue'
          AND n.created_at > CURRENT_DATE - INTERVAL '1 day'
      )
  LOOP
    PERFORM public.create_notification(
      r.organization_id,
      r.user_id,
      'warning',
      'invoice',
      'Invoice Overdue',
      'Invoice ' || r.invoice_number || ' is overdue since ' || r.due_date::TEXT,
      '/invoices',
      'invoice_overdue',
      r.id,
      1,
      r.business_id
    );
  END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public;

CREATE OR REPLACE FUNCTION public.check_low_stock_products()
RETURNS void AS $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN 
    SELECT p.id, p.name, p.sku, p.organization_id, p.business_id,
           p.stock_quantity, p.reorder_level, ur.user_id
    FROM public.products p
    JOIN public.user_roles ur ON ur.organization_id = p.organization_id AND ur.is_active = true
    WHERE p.track_inventory = true
      AND p.is_active = true
      AND p.reorder_level IS NOT NULL
      AND p.stock_quantity <= p.reorder_level
      AND NOT EXISTS (
        SELECT 1 FROM public.notifications n 
        WHERE n.entity_id = p.id 
          AND n.entity_type = 'low_stock'
          AND n.created_at > CURRENT_DATE - INTERVAL '1 day'
      )
  LOOP
    PERFORM public.create_notification(
      r.organization_id,
      r.user_id,
      'warning',
      'inventory',
      'Low Stock Alert',
      'Product "' || r.name || '" (' || COALESCE(r.sku, 'No SKU') || ') is below reorder level. Current: ' || r.stock_quantity || ', Reorder at: ' || r.reorder_level,
      '/inventory',
      'low_stock',
      r.id,
      1,
      r.business_id
    );
  END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public;

CREATE OR REPLACE FUNCTION public.notify_payment_received()
RETURNS TRIGGER AS $$
DECLARE
  v_invoice_number VARCHAR;
  v_user_id UUID;
BEGIN
  -- Get invoice number
  SELECT invoice_number INTO v_invoice_number
  FROM public.invoices WHERE id = NEW.invoice_id;
  
  -- Notify all org members
  FOR v_user_id IN 
    SELECT user_id FROM public.user_roles 
    WHERE organization_id = NEW.organization_id AND is_active = true
  LOOP
    PERFORM public.create_notification(
      NEW.organization_id,
      v_user_id,
      'success',
      'payment',
      'Payment Received',
      'Payment of ' || NEW.amount || ' received for invoice ' || COALESCE(v_invoice_number, 'N/A'),
      '/payments',
      'payment',
      NEW.id,
      0,
      NEW.business_id
    );
  END LOOP;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public;

CREATE OR REPLACE FUNCTION public.notify_new_team_member()
RETURNS TRIGGER AS $$
DECLARE
  v_org_name VARCHAR;
  v_user_id UUID;
BEGIN
  -- Get organization name
  SELECT name INTO v_org_name
  FROM public.organizations WHERE id = NEW.organization_id;
  
  -- Notify all existing org members (except the new one)
  FOR v_user_id IN 
    SELECT user_id FROM public.user_roles 
    WHERE organization_id = NEW.organization_id
      AND user_id != NEW.user_id
      AND is_active = true
  LOOP
    PERFORM public.create_notification(
      NEW.organization_id,
      v_user_id,
      'info',
      'team',
      'New Team Member',
      'A new member has joined ' || v_org_name,
      '/team',
      'team_member',
      NEW.id,
      0,
      NULL
    );
  END LOOP;
  
  -- Welcome notification for the new member
  PERFORM public.create_notification(
    NEW.organization_id,
    NEW.user_id,
    'success',
    'system',
    'Welcome!',
    'Welcome to ' || v_org_name || '! Get started by exploring the dashboard.',
    '/dashboard',
    'welcome',
    NULL,
    0,
    NULL
  );
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public;

-- Add notification trigger for invoice creation
CREATE OR REPLACE FUNCTION public.notify_invoice_created()
RETURNS TRIGGER AS $$
DECLARE
  v_user_id UUID;
  v_customer_name VARCHAR;
BEGIN
  -- Get customer name
  SELECT name INTO v_customer_name
  FROM public.contacts WHERE id = NEW.contact_id;
  
  -- Notify all org members
  FOR v_user_id IN 
    SELECT user_id FROM public.user_roles 
    WHERE organization_id = NEW.organization_id AND is_active = true
  LOOP
    PERFORM public.create_notification(
      NEW.organization_id,
      v_user_id,
      'info',
      'invoice',
      'Invoice Created',
      'Invoice ' || NEW.invoice_number || ' created for ' || COALESCE(v_customer_name, 'customer') || ' - ' || NEW.total,
      '/invoices',
      'invoice',
      NEW.id,
      0,
      NEW.business_id
    );
  END LOOP;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public;

DROP TRIGGER IF EXISTS trigger_notify_invoice_created ON public.invoices;
CREATE TRIGGER trigger_notify_invoice_created
  AFTER INSERT ON public.invoices
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_invoice_created();

-- Add notification trigger for expense creation
CREATE OR REPLACE FUNCTION public.notify_expense_created()
RETURNS TRIGGER AS $$
DECLARE
  v_user_id UUID;
BEGIN
  -- Notify all org members
  FOR v_user_id IN 
    SELECT user_id FROM public.user_roles 
    WHERE organization_id = NEW.organization_id AND is_active = true
  LOOP
    PERFORM public.create_notification(
      NEW.organization_id,
      v_user_id,
      'info',
      'expense',
      'Expense Recorded',
      'Expense of ' || NEW.amount || ' recorded - ' || COALESCE(NEW.description, 'No description'),
      '/expenses',
      'expense',
      NEW.id,
      0,
      NEW.business_id
    );
  END LOOP;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public;

DROP TRIGGER IF EXISTS trigger_notify_expense_created ON public.expenses;
CREATE TRIGGER trigger_notify_expense_created
  AFTER INSERT ON public.expenses
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_expense_created();