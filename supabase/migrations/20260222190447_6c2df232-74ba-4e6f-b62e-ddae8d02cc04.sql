
INSERT INTO public.platform_email_templates (template_key, name, description, subject, html_body, text_body, variables, category)
VALUES (
  'admin_new_signup_alert',
  'New User Signup Alert',
  'Sent to platform admins when a new user signs up',
  '🆕 New Signup: {{user_name}} just joined {{platform_name}}',
  '<div style="font-family: -apple-system, BlinkMacSystemFont, ''Segoe UI'', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 0; background-color: #ffffff;">
    <div style="background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); padding: 32px 24px; border-radius: 12px 12px 0 0;">
      <h1 style="color: #ffffff; font-size: 22px; margin: 0 0 4px 0;">New User Registration</h1>
      <p style="color: #94a3b8; font-size: 14px; margin: 0;">A new user has joined your platform</p>
    </div>
    <div style="padding: 32px 24px; background-color: #ffffff;">
      <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
        <table style="width: 100%; border-collapse: collapse;">
          <tr>
            <td style="padding: 8px 0; color: #64748b; font-size: 13px; width: 100px;">Name</td>
            <td style="padding: 8px 0; color: #1e293b; font-size: 14px; font-weight: 600;">{{user_name}}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #64748b; font-size: 13px;">Email</td>
            <td style="padding: 8px 0; color: #1e293b; font-size: 14px;">{{user_email}}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #64748b; font-size: 13px;">Signed up</td>
            <td style="padding: 8px 0; color: #1e293b; font-size: 14px;">{{signup_time}}</td>
          </tr>
        </table>
      </div>
      <a href="{{admin_url}}" style="display: inline-block; background: linear-gradient(135deg, #3b82f6, #2563eb); color: #ffffff; text-decoration: none; padding: 12px 24px; border-radius: 8px; font-size: 14px; font-weight: 600;">View in Admin Panel →</a>
    </div>
    <div style="padding: 16px 24px; background-color: #f8fafc; border-top: 1px solid #e2e8f0; border-radius: 0 0 12px 12px;">
      <p style="color: #94a3b8; font-size: 12px; margin: 0;">{{platform_name}} — Platform Admin Notification</p>
    </div>
  </div>',
  'New User Signup Alert

Name: {{user_name}}
Email: {{user_email}}
Signed up: {{signup_time}}

View in Admin Panel: {{admin_url}}

— {{platform_name}}',
  ARRAY['user_name', 'user_email', 'signup_time', 'admin_url', 'platform_name'],
  'admin'
)
ON CONFLICT (template_key) DO NOTHING;

-- Update handle_new_user() to fire admin notification via pg_net
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_supabase_url TEXT;
BEGIN
  -- Create profile (existing behavior)
  INSERT INTO public.profiles (user_id, email, full_name, avatar_url)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'name'),
    NEW.raw_user_meta_data->>'avatar_url'
  );

  -- Notify platform admins asynchronously via edge function
  BEGIN
    v_supabase_url := 'https://jkszmrroyjfdwokbkzis.supabase.co';

    PERFORM net.http_post(
      url := v_supabase_url || '/functions/v1/notify-admin-new-signup',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imprc3ptcnJveWpmZHdva2JremlzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc4MzkwMzEsImV4cCI6MjA4MzQxNTAzMX0.iJjPAh8zaed1XbgKnRZp63JLNU37Z72CJPHlSnEPaQc'
      ),
      body := jsonb_build_object(
        'user_id', NEW.id,
        'email', NEW.email,
        'full_name', COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'name', 'Unknown'),
        'signed_up_at', NEW.created_at
      )
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'Failed to notify admins of new signup: %', SQLERRM;
  END;

  RETURN NEW;
END;
$function$;
