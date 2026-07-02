-- =============================================
-- PHASE 3: NOTIFICATION SYSTEM DATABASE SCHEMA
-- =============================================

-- Create notifications table
CREATE TABLE IF NOT EXISTS public.notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id UUID REFERENCES public.businesses(id) ON DELETE SET NULL,
  user_id UUID NOT NULL,
  type VARCHAR(50) NOT NULL DEFAULT 'info', -- 'info', 'warning', 'error', 'success'
  category VARCHAR(50) NOT NULL DEFAULT 'system', -- 'invoice', 'inventory', 'payment', 'system', 'team', 'pos', 'expense'
  title VARCHAR(255) NOT NULL,
  message TEXT NOT NULL,
  link VARCHAR(500), -- Deep link to relevant page
  entity_type VARCHAR(50), -- 'invoice', 'product', 'contact', 'payment', etc.
  entity_id UUID,
  is_read BOOLEAN DEFAULT FALSE,
  is_dismissed BOOLEAN DEFAULT FALSE,
  priority INTEGER DEFAULT 0, -- Higher = more important (0=normal, 1=high, 2=urgent)
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create notification_preferences table
CREATE TABLE IF NOT EXISTS public.notification_preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  category VARCHAR(50) NOT NULL,
  email_enabled BOOLEAN DEFAULT TRUE,
  push_enabled BOOLEAN DEFAULT TRUE,
  in_app_enabled BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, organization_id, category)
);

-- Create indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON public.notifications(user_id, is_read, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_org ON public.notifications(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_business ON public.notifications(business_id);
CREATE INDEX IF NOT EXISTS idx_notifications_category ON public.notifications(category);
CREATE INDEX IF NOT EXISTS idx_notifications_entity ON public.notifications(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_notification_prefs_user ON public.notification_preferences(user_id, organization_id);

-- Enable RLS
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_preferences ENABLE ROW LEVEL SECURITY;

-- RLS Policies for notifications
CREATE POLICY "Users can view their own notifications" 
ON public.notifications FOR SELECT 
USING (user_id = auth.uid());

CREATE POLICY "Users can update their own notifications" 
ON public.notifications FOR UPDATE 
USING (user_id = auth.uid());

CREATE POLICY "Users can delete their own notifications" 
ON public.notifications FOR DELETE 
USING (user_id = auth.uid());

CREATE POLICY "System can insert notifications" 
ON public.notifications FOR INSERT 
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.user_roles 
    WHERE organization_id = notifications.organization_id 
    AND user_id = auth.uid()
    AND is_active = true
  )
  OR user_id = auth.uid()
);

-- RLS Policies for notification_preferences
CREATE POLICY "Users can view their own preferences" 
ON public.notification_preferences FOR SELECT 
USING (user_id = auth.uid());

CREATE POLICY "Users can insert their own preferences" 
ON public.notification_preferences FOR INSERT 
WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can update their own preferences" 
ON public.notification_preferences FOR UPDATE 
USING (user_id = auth.uid());

CREATE POLICY "Users can delete their own preferences" 
ON public.notification_preferences FOR DELETE 
USING (user_id = auth.uid());

-- Create function to update updated_at timestamp
CREATE OR REPLACE FUNCTION public.update_notification_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create triggers for updated_at
DROP TRIGGER IF EXISTS update_notifications_updated_at ON public.notifications;
CREATE TRIGGER update_notifications_updated_at
  BEFORE UPDATE ON public.notifications
  FOR EACH ROW
  EXECUTE FUNCTION public.update_notification_updated_at();

DROP TRIGGER IF EXISTS update_notification_preferences_updated_at ON public.notification_preferences;
CREATE TRIGGER update_notification_preferences_updated_at
  BEFORE UPDATE ON public.notification_preferences
  FOR EACH ROW
  EXECUTE FUNCTION public.update_notification_updated_at();

-- =============================================
-- NOTIFICATION TRIGGER FUNCTIONS
-- =============================================

-- Function to create notification
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
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger function for invoice overdue notifications
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
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger function for low stock notifications
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
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger for payment received notifications
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
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create trigger for payment notifications
DROP TRIGGER IF EXISTS trigger_notify_payment_received ON public.payments;
CREATE TRIGGER trigger_notify_payment_received
  AFTER INSERT ON public.payments
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_payment_received();

-- Trigger for new team member notifications
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
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create trigger for team member notifications
DROP TRIGGER IF EXISTS trigger_notify_new_team_member ON public.user_roles;
CREATE TRIGGER trigger_notify_new_team_member
  AFTER INSERT ON public.user_roles
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_new_team_member();