-- Fix: Create platform_email_logs table with correct column names
DROP TABLE IF EXISTS platform_email_logs;

CREATE TABLE platform_email_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_key text,
  template_id uuid REFERENCES platform_email_templates(id) ON DELETE SET NULL,
  campaign_id uuid REFERENCES platform_email_campaigns(id) ON DELETE SET NULL,
  rule_id uuid REFERENCES platform_automation_rules(id) ON DELETE SET NULL,
  recipient_email text NOT NULL,
  recipient_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  recipient_org_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
  subject text,
  status text DEFAULT 'pending',
  sent_at timestamp with time zone,
  opened_at timestamp with time zone,
  clicked_at timestamp with time zone,
  bounced_at timestamp with time zone,
  error_message text,
  resend_id text,
  metadata jsonb DEFAULT '{}',
  created_at timestamp with time zone DEFAULT now()
);

-- Create indexes for email logs
CREATE INDEX idx_email_logs_recipient ON platform_email_logs(recipient_email);
CREATE INDEX idx_email_logs_status ON platform_email_logs(status, created_at);
CREATE INDEX idx_email_logs_campaign ON platform_email_logs(campaign_id) WHERE campaign_id IS NOT NULL;
CREATE INDEX idx_email_logs_rule ON platform_email_logs(rule_id) WHERE rule_id IS NOT NULL;

-- Add RLS to platform_email_logs (admin only)
ALTER TABLE platform_email_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Platform admins can view email logs" ON platform_email_logs
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM platform_admins WHERE user_id = auth.uid() AND is_active = true)
  );

CREATE POLICY "Platform admins can manage email logs" ON platform_email_logs
  FOR ALL USING (
    EXISTS (SELECT 1 FROM platform_admins WHERE user_id = auth.uid() AND is_active = true)
  );

-- Create function to count sample data for an organization
CREATE OR REPLACE FUNCTION get_sample_data_counts(org_id uuid)
RETURNS TABLE (
  table_name text,
  sample_count bigint,
  total_count bigint
) AS $$
BEGIN
  RETURN QUERY
  SELECT 'contacts'::text, 
    (SELECT count(*) FROM contacts WHERE organization_id = org_id AND is_sample_data = true),
    (SELECT count(*) FROM contacts WHERE organization_id = org_id)
  UNION ALL
  SELECT 'products'::text,
    (SELECT count(*) FROM products WHERE organization_id = org_id AND is_sample_data = true),
    (SELECT count(*) FROM products WHERE organization_id = org_id)
  UNION ALL
  SELECT 'invoices'::text,
    (SELECT count(*) FROM invoices WHERE organization_id = org_id AND is_sample_data = true),
    (SELECT count(*) FROM invoices WHERE organization_id = org_id)
  UNION ALL
  SELECT 'bills'::text,
    (SELECT count(*) FROM bills WHERE organization_id = org_id AND is_sample_data = true),
    (SELECT count(*) FROM bills WHERE organization_id = org_id)
  UNION ALL
  SELECT 'expenses'::text,
    (SELECT count(*) FROM expenses WHERE organization_id = org_id AND is_sample_data = true),
    (SELECT count(*) FROM expenses WHERE organization_id = org_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Grant execute on the function
GRANT EXECUTE ON FUNCTION get_sample_data_counts(uuid) TO authenticated;