-- =====================================================
-- PHASE 2: COMMUNICATION ENHANCEMENTS
-- =====================================================

-- =====================================================
-- 1. EMAIL TEMPLATES TABLE
-- =====================================================

CREATE TABLE IF NOT EXISTS public.email_templates (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id UUID REFERENCES public.businesses(id) ON DELETE CASCADE,
  template_key TEXT NOT NULL, -- 'invoice_sent', 'payment_reminder', 'estimate_sent', etc.
  name TEXT NOT NULL,
  subject TEXT NOT NULL,
  html_body TEXT NOT NULL,
  text_body TEXT,
  variables JSONB DEFAULT '[]'::jsonb, -- Available variables like {{customer_name}}, {{invoice_number}}
  is_active BOOLEAN DEFAULT true,
  is_default BOOLEAN DEFAULT false,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(organization_id, business_id, template_key)
);

ALTER TABLE public.email_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view email templates in their orgs" 
ON public.email_templates FOR SELECT 
USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can manage email templates in their orgs" 
ON public.email_templates FOR ALL 
USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_email_templates_lookup 
ON public.email_templates(organization_id, business_id, template_key, is_active);

-- =====================================================
-- 2. DOCUMENT COMMENTS TABLE (Chatter-like)
-- =====================================================

CREATE TABLE IF NOT EXISTS public.document_comments (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL, -- 'invoice', 'bill', 'estimate', 'sales_order', 'purchase_order'
  entity_id UUID NOT NULL,
  parent_id UUID REFERENCES public.document_comments(id) ON DELETE CASCADE, -- For threaded replies
  user_id UUID REFERENCES auth.users(id),
  comment_type TEXT NOT NULL DEFAULT 'comment', -- 'comment', 'system', 'status_change', 'email_sent', 'payment_received'
  content TEXT NOT NULL,
  mentions UUID[] DEFAULT '{}', -- Array of mentioned user IDs
  attachments JSONB DEFAULT '[]'::jsonb, -- [{name, url, size, type}]
  metadata JSONB DEFAULT '{}'::jsonb, -- Additional context like old/new status, amount, etc.
  is_internal BOOLEAN DEFAULT false, -- Internal notes not visible to customers
  is_pinned BOOLEAN DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.document_comments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view comments in their orgs" 
ON public.document_comments FOR SELECT 
USING (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can create comments in their orgs" 
ON public.document_comments FOR INSERT 
WITH CHECK (organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can update their own comments" 
ON public.document_comments FOR UPDATE 
USING (user_id = auth.uid() OR organization_id IN (SELECT get_user_organizations(auth.uid())));

CREATE POLICY "Users can delete their own comments" 
ON public.document_comments FOR DELETE 
USING (user_id = auth.uid());

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_document_comments_entity 
ON public.document_comments(organization_id, entity_type, entity_id);

CREATE INDEX IF NOT EXISTS idx_document_comments_user 
ON public.document_comments(user_id);

CREATE INDEX IF NOT EXISTS idx_document_comments_mentions 
ON public.document_comments USING GIN(mentions);

-- =====================================================
-- 3. FUNCTION TO AUTO-LOG DOCUMENT ACTIVITY
-- =====================================================

CREATE OR REPLACE FUNCTION public.log_document_activity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_entity_type TEXT;
  v_entity_name TEXT;
  v_content TEXT;
  v_metadata JSONB;
BEGIN
  -- Determine entity type based on TG_TABLE_NAME
  v_entity_type := TG_TABLE_NAME;
  
  -- Handle status changes
  IF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN
    v_content := 'Status changed from ' || COALESCE(OLD.status, 'none') || ' to ' || NEW.status;
    v_metadata := jsonb_build_object(
      'old_status', OLD.status,
      'new_status', NEW.status,
      'changed_at', now()
    );
    
    -- Get entity name
    IF TG_TABLE_NAME = 'invoices' THEN
      v_entity_name := NEW.invoice_number;
    ELSIF TG_TABLE_NAME = 'bills' THEN
      v_entity_name := NEW.bill_number;
    ELSIF TG_TABLE_NAME = 'estimates' THEN
      v_entity_name := NEW.estimate_number;
    ELSIF TG_TABLE_NAME = 'sales_orders' THEN
      v_entity_name := NEW.order_number;
    ELSIF TG_TABLE_NAME = 'purchase_orders' THEN
      v_entity_name := NEW.order_number;
    END IF;
    
    INSERT INTO document_comments (
      organization_id,
      entity_type,
      entity_id,
      comment_type,
      content,
      metadata,
      is_internal
    ) VALUES (
      NEW.organization_id,
      v_entity_type,
      NEW.id,
      'status_change',
      v_content,
      v_metadata,
      true
    );
  END IF;
  
  RETURN NEW;
END;
$$;

-- Create triggers for automatic activity logging
DROP TRIGGER IF EXISTS trigger_invoice_activity ON public.invoices;
CREATE TRIGGER trigger_invoice_activity
  AFTER UPDATE ON public.invoices
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION log_document_activity();

DROP TRIGGER IF EXISTS trigger_bill_activity ON public.bills;
CREATE TRIGGER trigger_bill_activity
  AFTER UPDATE ON public.bills
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION log_document_activity();

DROP TRIGGER IF EXISTS trigger_estimate_activity ON public.estimates;
CREATE TRIGGER trigger_estimate_activity
  AFTER UPDATE ON public.estimates
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION log_document_activity();

-- =====================================================
-- 4. SEED DEFAULT EMAIL TEMPLATES (per organization on first use)
-- =====================================================

CREATE OR REPLACE FUNCTION public.ensure_default_email_templates(_org_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Invoice Sent Template
  INSERT INTO email_templates (organization_id, template_key, name, subject, html_body, variables)
  VALUES (
    _org_id,
    'invoice_sent',
    'Invoice Sent',
    'Invoice {{invoice_number}} from {{business_name}}',
    '<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2>Invoice {{invoice_number}}</h2>
      <p>Dear {{customer_name}},</p>
      <p>Please find attached invoice {{invoice_number}} for {{total}} {{currency}}.</p>
      <p><strong>Due Date:</strong> {{due_date}}</p>
      <p>{{notes}}</p>
      <p>Thank you for your business!</p>
      <p>Best regards,<br>{{business_name}}</p>
    </div>',
    '["invoice_number", "customer_name", "total", "currency", "due_date", "notes", "business_name", "view_link"]'::jsonb
  )
  ON CONFLICT (organization_id, business_id, template_key) DO NOTHING;
  
  -- Payment Reminder Template
  INSERT INTO email_templates (organization_id, template_key, name, subject, html_body, variables)
  VALUES (
    _org_id,
    'payment_reminder',
    'Payment Reminder',
    'Reminder: Invoice {{invoice_number}} is due',
    '<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2>Payment Reminder</h2>
      <p>Dear {{customer_name}},</p>
      <p>This is a friendly reminder that invoice {{invoice_number}} for {{total}} {{currency}} is due on {{due_date}}.</p>
      <p>If you have already made the payment, please disregard this reminder.</p>
      <p>Best regards,<br>{{business_name}}</p>
    </div>',
    '["invoice_number", "customer_name", "total", "currency", "due_date", "business_name", "view_link"]'::jsonb
  )
  ON CONFLICT (organization_id, business_id, template_key) DO NOTHING;
  
  -- Payment Receipt Template
  INSERT INTO email_templates (organization_id, template_key, name, subject, html_body, variables)
  VALUES (
    _org_id,
    'payment_receipt',
    'Payment Receipt',
    'Payment Received - Receipt {{receipt_number}}',
    '<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2>Payment Receipt</h2>
      <p>Dear {{customer_name}},</p>
      <p>We have received your payment of {{amount}} {{currency}}.</p>
      <p><strong>Receipt Number:</strong> {{receipt_number}}</p>
      <p><strong>Payment Date:</strong> {{payment_date}}</p>
      <p><strong>Payment Method:</strong> {{payment_method}}</p>
      <p>Thank you for your payment!</p>
      <p>Best regards,<br>{{business_name}}</p>
    </div>',
    '["receipt_number", "customer_name", "amount", "currency", "payment_date", "payment_method", "business_name"]'::jsonb
  )
  ON CONFLICT (organization_id, business_id, template_key) DO NOTHING;
  
  -- Estimate Sent Template
  INSERT INTO email_templates (organization_id, template_key, name, subject, html_body, variables)
  VALUES (
    _org_id,
    'estimate_sent',
    'Estimate Sent',
    'Estimate {{estimate_number}} from {{business_name}}',
    '<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2>Estimate {{estimate_number}}</h2>
      <p>Dear {{customer_name}},</p>
      <p>Please find attached estimate {{estimate_number}} for {{total}} {{currency}}.</p>
      <p><strong>Valid Until:</strong> {{valid_until}}</p>
      <p>{{notes}}</p>
      <p>Please let us know if you have any questions.</p>
      <p>Best regards,<br>{{business_name}}</p>
    </div>',
    '["estimate_number", "customer_name", "total", "currency", "valid_until", "notes", "business_name", "view_link"]'::jsonb
  )
  ON CONFLICT (organization_id, business_id, template_key) DO NOTHING;
  
  -- Overdue Invoice Template
  INSERT INTO email_templates (organization_id, template_key, name, subject, html_body, variables)
  VALUES (
    _org_id,
    'invoice_overdue',
    'Invoice Overdue',
    'OVERDUE: Invoice {{invoice_number}} requires immediate attention',
    '<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #dc2626;">Invoice Overdue</h2>
      <p>Dear {{customer_name}},</p>
      <p>Invoice {{invoice_number}} for {{total}} {{currency}} was due on {{due_date}} and is now {{days_overdue}} days overdue.</p>
      <p><strong>Amount Due:</strong> {{balance_due}} {{currency}}</p>
      <p>Please arrange payment at your earliest convenience to avoid any service interruptions.</p>
      <p>If you have any questions or need to discuss payment arrangements, please contact us.</p>
      <p>Best regards,<br>{{business_name}}</p>
    </div>',
    '["invoice_number", "customer_name", "total", "currency", "due_date", "days_overdue", "balance_due", "business_name", "view_link"]'::jsonb
  )
  ON CONFLICT (organization_id, business_id, template_key) DO NOTHING;

END;
$$;

-- =====================================================
-- 5. CREATE FUNCTION TO NOTIFY ON MENTIONS
-- =====================================================

CREATE OR REPLACE FUNCTION public.notify_comment_mentions()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_mentioned_user UUID;
  v_commenter_name TEXT;
  v_entity_name TEXT;
BEGIN
  -- Get commenter name
  SELECT COALESCE(raw_user_meta_data->>'full_name', email) INTO v_commenter_name
  FROM auth.users WHERE id = NEW.user_id;
  
  -- Get entity reference
  IF NEW.entity_type = 'invoices' THEN
    SELECT invoice_number INTO v_entity_name FROM invoices WHERE id = NEW.entity_id;
  ELSIF NEW.entity_type = 'bills' THEN
    SELECT bill_number INTO v_entity_name FROM bills WHERE id = NEW.entity_id;
  ELSIF NEW.entity_type = 'estimates' THEN
    SELECT estimate_number INTO v_entity_name FROM estimates WHERE id = NEW.entity_id;
  END IF;
  
  -- Create notification for each mentioned user
  FOREACH v_mentioned_user IN ARRAY COALESCE(NEW.mentions, '{}')
  LOOP
    INSERT INTO notifications (
      organization_id,
      user_id,
      type,
      title,
      message,
      link,
      priority,
      metadata
    ) VALUES (
      NEW.organization_id,
      v_mentioned_user,
      'mention',
      'You were mentioned in a comment',
      COALESCE(v_commenter_name, 'Someone') || ' mentioned you on ' || COALESCE(v_entity_name, NEW.entity_type),
      '/' || NEW.entity_type,
      'high',
      jsonb_build_object(
        'entity_type', NEW.entity_type,
        'entity_id', NEW.entity_id,
        'comment_id', NEW.id,
        'commenter_id', NEW.user_id
      )
    );
  END LOOP;
  
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_comment_mentions ON public.document_comments;
CREATE TRIGGER trigger_comment_mentions
  AFTER INSERT ON public.document_comments
  FOR EACH ROW
  WHEN (array_length(NEW.mentions, 1) > 0)
  EXECUTE FUNCTION notify_comment_mentions();