
-- Create platform_admin_notifications table
CREATE TABLE IF NOT EXISTS public.platform_admin_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id UUID NOT NULL,
  type VARCHAR(50) NOT NULL DEFAULT 'info',
  category VARCHAR(50) NOT NULL DEFAULT 'system',
  title VARCHAR(255) NOT NULL,
  message TEXT NOT NULL,
  link VARCHAR(500),
  metadata JSONB DEFAULT '{}',
  is_read BOOLEAN DEFAULT FALSE,
  is_dismissed BOOLEAN DEFAULT FALSE,
  priority INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_platform_admin_notif_user ON public.platform_admin_notifications(admin_user_id, is_read, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_admin_notif_category ON public.platform_admin_notifications(category);

ALTER TABLE public.platform_admin_notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can view own notifications"
ON public.platform_admin_notifications FOR SELECT
USING (admin_user_id = auth.uid());

CREATE POLICY "Admins can update own notifications"
ON public.platform_admin_notifications FOR UPDATE
USING (admin_user_id = auth.uid());

CREATE POLICY "Admins can delete own notifications"
ON public.platform_admin_notifications FOR DELETE
USING (admin_user_id = auth.uid());

CREATE POLICY "Service can insert admin notifications"
ON public.platform_admin_notifications FOR INSERT
WITH CHECK (true);

CREATE TRIGGER update_platform_admin_notif_updated_at
  BEFORE UPDATE ON public.platform_admin_notifications
  FOR EACH ROW
  EXECUTE FUNCTION public.update_notification_updated_at();
