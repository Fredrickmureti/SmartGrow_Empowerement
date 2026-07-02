-- Add activity tracking fields to profiles
ALTER TABLE public.profiles 
ADD COLUMN IF NOT EXISTS last_login_at timestamptz,
ADD COLUMN IF NOT EXISTS last_activity_at timestamptz,
ADD COLUMN IF NOT EXISTS login_count integer DEFAULT 0,
ADD COLUMN IF NOT EXISTS engagement_score integer DEFAULT 0;

-- User activity logs table
CREATE TABLE IF NOT EXISTS public.user_activity_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  organization_id uuid REFERENCES public.organizations(id) ON DELETE SET NULL,
  activity_type text NOT NULL,
  activity_details jsonb,
  ip_address text,
  user_agent text,
  created_at timestamptz DEFAULT now()
);

-- Platform email templates (admin-level)
CREATE TABLE IF NOT EXISTS public.platform_email_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_key text UNIQUE NOT NULL,
  name text NOT NULL,
  description text,
  subject text NOT NULL,
  html_body text NOT NULL,
  text_body text,
  variables text[] DEFAULT '{}',
  category text DEFAULT 'general',
  is_active boolean DEFAULT true,
  created_by uuid,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Platform email campaigns
CREATE TABLE IF NOT EXISTS public.platform_email_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  template_id uuid REFERENCES public.platform_email_templates(id) ON DELETE SET NULL,
  custom_subject text,
  custom_html_body text,
  target_audience jsonb DEFAULT '{}',
  scheduled_at timestamptz,
  sent_at timestamptz,
  status text DEFAULT 'draft',
  recipient_count integer DEFAULT 0,
  sent_count integer DEFAULT 0,
  failed_count integer DEFAULT 0,
  opened_count integer DEFAULT 0,
  stats jsonb DEFAULT '{}',
  created_by uuid,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Platform email logs (individual send records)
CREATE TABLE IF NOT EXISTS public.platform_email_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid REFERENCES public.platform_email_campaigns(id) ON DELETE SET NULL,
  recipient_email text NOT NULL,
  recipient_user_id uuid,
  recipient_name text,
  subject text NOT NULL,
  html_body text,
  status text DEFAULT 'pending',
  resend_id text,
  sent_at timestamptz,
  opened_at timestamptz,
  clicked_at timestamptz,
  error_message text,
  metadata jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now()
);

-- Platform automation rules
CREATE TABLE IF NOT EXISTS public.platform_automation_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  trigger_type text NOT NULL,
  trigger_config jsonb DEFAULT '{}',
  action_type text NOT NULL DEFAULT 'send_email',
  template_id uuid REFERENCES public.platform_email_templates(id) ON DELETE SET NULL,
  delay_minutes integer DEFAULT 0,
  is_active boolean DEFAULT true,
  priority integer DEFAULT 0,
  last_run_at timestamptz,
  next_run_at timestamptz,
  run_count integer DEFAULT 0,
  created_by uuid,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_user_activity_logs_user_id ON public.user_activity_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_user_activity_logs_created_at ON public.user_activity_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_user_activity_logs_activity_type ON public.user_activity_logs(activity_type);
CREATE INDEX IF NOT EXISTS idx_platform_email_templates_category ON public.platform_email_templates(category);
CREATE INDEX IF NOT EXISTS idx_platform_email_templates_is_active ON public.platform_email_templates(is_active);
CREATE INDEX IF NOT EXISTS idx_platform_email_campaigns_status ON public.platform_email_campaigns(status);
CREATE INDEX IF NOT EXISTS idx_platform_email_campaigns_scheduled_at ON public.platform_email_campaigns(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_platform_email_logs_campaign_id ON public.platform_email_logs(campaign_id);
CREATE INDEX IF NOT EXISTS idx_platform_email_logs_recipient_user_id ON public.platform_email_logs(recipient_user_id);
CREATE INDEX IF NOT EXISTS idx_platform_email_logs_status ON public.platform_email_logs(status);
CREATE INDEX IF NOT EXISTS idx_platform_automation_rules_trigger_type ON public.platform_automation_rules(trigger_type);
CREATE INDEX IF NOT EXISTS idx_platform_automation_rules_is_active ON public.platform_automation_rules(is_active);
CREATE INDEX IF NOT EXISTS idx_profiles_last_login_at ON public.profiles(last_login_at);
CREATE INDEX IF NOT EXISTS idx_profiles_engagement_score ON public.profiles(engagement_score);

-- Enable RLS on all new tables
ALTER TABLE public.user_activity_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_email_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_email_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_email_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_automation_rules ENABLE ROW LEVEL SECURITY;

-- RLS Policies for platform admins only (using existing platform_admins table)
-- User activity logs - platform admins can read all, service role can write
CREATE POLICY "Platform admins can view all activity logs"
ON public.user_activity_logs FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.platform_admins
    WHERE user_id = auth.uid() AND is_active = true
  )
);

CREATE POLICY "Service role can insert activity logs"
ON public.user_activity_logs FOR INSERT
TO authenticated
WITH CHECK (true);

-- Platform email templates - platform admins full access
CREATE POLICY "Platform admins can manage email templates"
ON public.platform_email_templates FOR ALL
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.platform_admins
    WHERE user_id = auth.uid() AND is_active = true
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.platform_admins
    WHERE user_id = auth.uid() AND is_active = true
  )
);

-- Platform email campaigns - platform admins full access
CREATE POLICY "Platform admins can manage campaigns"
ON public.platform_email_campaigns FOR ALL
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.platform_admins
    WHERE user_id = auth.uid() AND is_active = true
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.platform_admins
    WHERE user_id = auth.uid() AND is_active = true
  )
);

-- Platform email logs - platform admins full access
CREATE POLICY "Platform admins can manage email logs"
ON public.platform_email_logs FOR ALL
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.platform_admins
    WHERE user_id = auth.uid() AND is_active = true
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.platform_admins
    WHERE user_id = auth.uid() AND is_active = true
  )
);

-- Platform automation rules - platform admins full access
CREATE POLICY "Platform admins can manage automation rules"
ON public.platform_automation_rules FOR ALL
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.platform_admins
    WHERE user_id = auth.uid() AND is_active = true
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.platform_admins
    WHERE user_id = auth.uid() AND is_active = true
  )
);

-- Function to update user activity on login
CREATE OR REPLACE FUNCTION public.update_user_login_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Update profile with login info
  UPDATE public.profiles
  SET 
    last_login_at = now(),
    last_activity_at = now(),
    login_count = COALESCE(login_count, 0) + 1
  WHERE user_id = NEW.id;
  
  -- Log the activity
  INSERT INTO public.user_activity_logs (user_id, activity_type, activity_details)
  VALUES (NEW.id, 'login', jsonb_build_object('provider', NEW.raw_app_meta_data->>'provider'));
  
  RETURN NEW;
END;
$$;

-- Function to update last_activity_at timestamp
CREATE OR REPLACE FUNCTION public.update_profile_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- Trigger for updating timestamps on templates
CREATE TRIGGER update_platform_email_templates_updated_at
  BEFORE UPDATE ON public.platform_email_templates
  FOR EACH ROW
  EXECUTE FUNCTION public.update_profile_updated_at();

-- Trigger for updating timestamps on campaigns
CREATE TRIGGER update_platform_email_campaigns_updated_at
  BEFORE UPDATE ON public.platform_email_campaigns
  FOR EACH ROW
  EXECUTE FUNCTION public.update_profile_updated_at();

-- Trigger for updating timestamps on automation rules
CREATE TRIGGER update_platform_automation_rules_updated_at
  BEFORE UPDATE ON public.platform_automation_rules
  FOR EACH ROW
  EXECUTE FUNCTION public.update_profile_updated_at();

-- Insert default email templates
INSERT INTO public.platform_email_templates (template_key, name, description, subject, html_body, text_body, variables, category)
VALUES 
  ('welcome_new_user', 'Welcome New User', 'Sent to new users after signup', 
   'Welcome to {{platform_name}}! 🎉', 
   '<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;"><h1 style="color: #333;">Welcome, {{user_name}}!</h1><p style="font-size: 16px; color: #666;">We''re thrilled to have you join {{platform_name}}. Your account is all set up and ready to go.</p><p style="font-size: 16px; color: #666;">Here''s what you can do next:</p><ul style="font-size: 16px; color: #666;"><li>Complete your profile</li><li>Explore our features</li><li>Connect with your team</li></ul><p style="font-size: 16px; color: #666;">If you have any questions, we''re here to help!</p><p style="font-size: 16px; color: #666;">Best regards,<br>The {{platform_name}} Team</p></div>',
   'Welcome, {{user_name}}! We''re thrilled to have you join {{platform_name}}. Your account is all set up and ready to go.',
   ARRAY['user_name', 'user_email', 'platform_name'],
   'welcome'),
   
  ('reengagement_7_days', 'Re-engagement - 7 Days Inactive', 'Sent to users inactive for 7 days',
   'We miss you at {{platform_name}}! 👋',
   '<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;"><h1 style="color: #333;">Hey {{user_name}}, we miss you!</h1><p style="font-size: 16px; color: #666;">It''s been {{days_inactive}} days since we last saw you at {{platform_name}}. A lot has happened since you''ve been away!</p><p style="font-size: 16px; color: #666;">Here''s what''s new:</p><ul style="font-size: 16px; color: #666;"><li>{{feature_highlight_1}}</li><li>{{feature_highlight_2}}</li></ul><a href="{{login_url}}" style="display: inline-block; background-color: #007bff; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; margin-top: 15px;">Log Back In</a><p style="font-size: 16px; color: #666; margin-top: 20px;">See you soon!</p></div>',
   'Hey {{user_name}}, we miss you! It''s been {{days_inactive}} days since we last saw you.',
   ARRAY['user_name', 'days_inactive', 'platform_name', 'login_url', 'feature_highlight_1', 'feature_highlight_2'],
   'reengagement'),
   
  ('feature_announcement', 'Feature Announcement', 'Template for announcing new features',
   '🚀 New Feature: {{feature_name}} is Here!',
   '<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;"><h1 style="color: #333;">Introducing {{feature_name}}!</h1><p style="font-size: 16px; color: #666;">Hi {{user_name}},</p><p style="font-size: 16px; color: #666;">We''re excited to announce {{feature_name}} - {{feature_description}}</p><p style="font-size: 16px; color: #666;">{{feature_details}}</p><a href="{{feature_url}}" style="display: inline-block; background-color: #28a745; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; margin-top: 15px;">Try It Now</a><p style="font-size: 16px; color: #666; margin-top: 20px;">Happy exploring!<br>The {{platform_name}} Team</p></div>',
   'Hi {{user_name}}, We''re excited to announce {{feature_name}} - {{feature_description}}',
   ARRAY['user_name', 'feature_name', 'feature_description', 'feature_details', 'feature_url', 'platform_name'],
   'announcement'),
   
  ('system_maintenance', 'System Maintenance Notice', 'Notify users about scheduled maintenance',
   '⚙️ Scheduled Maintenance - {{maintenance_date}}',
   '<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;"><h1 style="color: #333;">Scheduled Maintenance Notice</h1><p style="font-size: 16px; color: #666;">Hi {{user_name}},</p><p style="font-size: 16px; color: #666;">We''ll be performing scheduled maintenance on <strong>{{maintenance_date}}</strong> from <strong>{{start_time}}</strong> to <strong>{{end_time}}</strong>.</p><p style="font-size: 16px; color: #666;">During this time, {{platform_name}} may be temporarily unavailable.</p><p style="font-size: 16px; color: #666;">We apologize for any inconvenience and appreciate your patience.</p><p style="font-size: 16px; color: #666;">Best regards,<br>The {{platform_name}} Team</p></div>',
   'Hi {{user_name}}, We''ll be performing scheduled maintenance on {{maintenance_date}} from {{start_time}} to {{end_time}}.',
   ARRAY['user_name', 'maintenance_date', 'start_time', 'end_time', 'platform_name'],
   'system')
ON CONFLICT (template_key) DO NOTHING;

-- Insert default automation rules
INSERT INTO public.platform_automation_rules (name, description, trigger_type, trigger_config, action_type, is_active)
VALUES 
  ('Welcome Email', 'Send welcome email to new users', 'signup', '{"delay_minutes": 0}', 'send_email', false),
  ('7-Day Inactivity', 'Re-engage users inactive for 7 days', 'inactivity', '{"days_inactive": 7}', 'send_email', false),
  ('14-Day Inactivity', 'Re-engage users inactive for 14 days', 'inactivity', '{"days_inactive": 14}', 'send_email', false),
  ('30-Day Inactivity', 'Win-back users inactive for 30 days', 'inactivity', '{"days_inactive": 30}', 'send_email', false)
ON CONFLICT DO NOTHING;