-- Create platform_settings table for SaaS-level configuration
CREATE TABLE public.platform_settings (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    setting_key TEXT NOT NULL UNIQUE,
    setting_value TEXT,
    setting_type TEXT NOT NULL DEFAULT 'string', -- string, boolean, number, json
    description TEXT,
    is_secret BOOLEAN DEFAULT false, -- indicates if value should be masked in UI
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create trigger for updated_at
CREATE TRIGGER update_platform_settings_updated_at
    BEFORE UPDATE ON public.platform_settings
    FOR EACH ROW
    EXECUTE FUNCTION public.update_updated_at_column();

-- Enable RLS
ALTER TABLE public.platform_settings ENABLE ROW LEVEL SECURITY;

-- Only platform admins can view platform settings
CREATE POLICY "Platform admins can view platform settings"
    ON public.platform_settings
    FOR SELECT
    USING (public.is_platform_admin(auth.uid()));

-- Only platform admins can manage platform settings
CREATE POLICY "Platform admins can manage platform settings"
    ON public.platform_settings
    FOR ALL
    USING (public.is_platform_admin(auth.uid()))
    WITH CHECK (public.is_platform_admin(auth.uid()));

-- Insert default settings structure
INSERT INTO public.platform_settings (setting_key, setting_value, setting_type, description, is_secret) VALUES
    ('platform_name', 'BookFlow', 'string', 'The name of the platform displayed to users', false),
    ('support_email', 'support@bookflow.app', 'string', 'Support email address', false),
    ('website_url', 'https://bookflow.app', 'string', 'Platform website URL', false),
    ('resend_api_key', NULL, 'string', 'Resend API key for sending emails', true),
    ('resend_from_email', 'noreply@bookflow.app', 'string', 'Default from email address for Resend', false),
    ('resend_from_name', 'BookFlow', 'string', 'Default from name for emails', false),
    ('email_provider', 'resend', 'string', 'Email service provider (resend, sendgrid, mailgun)', false),
    ('sendgrid_api_key', NULL, 'string', 'SendGrid API key for sending emails', true),
    ('mailgun_api_key', NULL, 'string', 'Mailgun API key for sending emails', true),
    ('mailgun_domain', NULL, 'string', 'Mailgun domain for sending emails', false),
    ('maintenance_mode', 'false', 'boolean', 'Enable maintenance mode', false),
    ('allow_signups', 'true', 'boolean', 'Allow new user registrations', false);