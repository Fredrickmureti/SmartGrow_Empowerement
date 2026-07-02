-- =====================================================
-- PHASE 2: Notification Alert Settings & Reorder Rules
-- =====================================================

-- 1. Create notification_alert_settings table for customizable thresholds
CREATE TABLE IF NOT EXISTS public.notification_alert_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  
  -- Inventory Alert Thresholds
  low_stock_warning_threshold INTEGER DEFAULT 10,
  low_stock_critical_threshold INTEGER DEFAULT 5,
  out_of_stock_alert BOOLEAN DEFAULT true,
  
  -- Invoice Alert Settings
  invoice_reminder_days_before INTEGER DEFAULT 7,
  overdue_reminder_frequency_days INTEGER DEFAULT 7,
  overdue_escalation_enabled BOOLEAN DEFAULT true,
  
  -- Payment Alert Settings
  payment_received_notify BOOLEAN DEFAULT true,
  large_payment_threshold NUMERIC(12,2) DEFAULT 10000,
  
  -- Expense Alert Settings
  expense_approval_required_above NUMERIC(12,2) DEFAULT 5000,
  
  -- Digest/Summary Settings
  daily_digest_enabled BOOLEAN DEFAULT false,
  weekly_digest_enabled BOOLEAN DEFAULT true,
  digest_send_hour INTEGER DEFAULT 8,
  digest_timezone VARCHAR(50) DEFAULT 'Africa/Nairobi',
  
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  
  UNIQUE(organization_id, business_id)
);

-- 2. Create product_reorder_rules table for per-product configuration (Odoo-style)
CREATE TABLE IF NOT EXISTS public.product_reorder_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  warehouse_id UUID REFERENCES warehouses(id) ON DELETE CASCADE,
  
  -- Reorder Thresholds
  min_quantity INTEGER NOT NULL DEFAULT 0,
  max_quantity INTEGER,
  warning_threshold INTEGER,
  critical_threshold INTEGER,
  
  -- Supplier & Lead Time
  lead_time_days INTEGER DEFAULT 0,
  preferred_supplier_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  
  -- Automation Settings
  auto_create_po BOOLEAN DEFAULT false,
  reorder_quantity INTEGER,
  
  -- Notification Override
  custom_notification_enabled BOOLEAN DEFAULT true,
  notify_user_ids UUID[] DEFAULT '{}',
  
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  
  UNIQUE(organization_id, product_id, warehouse_id)
);

-- 3. Create notification_digest_queue for batched notifications
CREATE TABLE IF NOT EXISTS public.notification_digest_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  notification_id UUID REFERENCES notifications(id) ON DELETE CASCADE,
  digest_type VARCHAR(20) NOT NULL DEFAULT 'daily',
  scheduled_for DATE NOT NULL,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 4. Enable RLS on new tables
ALTER TABLE notification_alert_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_reorder_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_digest_queue ENABLE ROW LEVEL SECURITY;

-- 5. Create RLS policies for notification_alert_settings
CREATE POLICY "Users can view their organization settings" ON notification_alert_settings
  FOR SELECT USING (
    organization_id IN (SELECT public.get_user_organizations(auth.uid()))
  );

CREATE POLICY "Admins can manage notification settings" ON notification_alert_settings
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM user_roles 
      WHERE user_id = auth.uid() 
        AND organization_id = notification_alert_settings.organization_id
        AND role IN ('owner', 'admin', 'super_admin')
        AND is_active = true
    )
  );

-- 6. Create RLS policies for product_reorder_rules
CREATE POLICY "Users can view their organization reorder rules" ON product_reorder_rules
  FOR SELECT USING (
    organization_id IN (SELECT public.get_user_organizations(auth.uid()))
  );

CREATE POLICY "Admins can manage reorder rules" ON product_reorder_rules
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM user_roles 
      WHERE user_id = auth.uid() 
        AND organization_id = product_reorder_rules.organization_id
        AND role IN ('owner', 'admin', 'super_admin', 'staff')
        AND is_active = true
    )
  );

-- 7. Create RLS policies for notification_digest_queue
CREATE POLICY "Users can view their own digest queue" ON notification_digest_queue
  FOR SELECT USING (user_id = auth.uid());

CREATE POLICY "System can manage digest queue" ON notification_digest_queue
  FOR ALL USING (
    organization_id IN (SELECT public.get_user_organizations(auth.uid()))
  );

-- 8. Create updated_at triggers
CREATE TRIGGER update_notification_alert_settings_updated_at
  BEFORE UPDATE ON notification_alert_settings
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_product_reorder_rules_updated_at
  BEFORE UPDATE ON product_reorder_rules
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- 9. Create index for performance
CREATE INDEX IF NOT EXISTS idx_notification_alert_settings_org 
  ON notification_alert_settings(organization_id);
CREATE INDEX IF NOT EXISTS idx_product_reorder_rules_org_product 
  ON product_reorder_rules(organization_id, product_id);
CREATE INDEX IF NOT EXISTS idx_product_reorder_rules_product 
  ON product_reorder_rules(product_id);
CREATE INDEX IF NOT EXISTS idx_notification_digest_queue_scheduled 
  ON notification_digest_queue(scheduled_for, sent_at) WHERE sent_at IS NULL;