
-- User security preferences for inactivity lock settings
CREATE TABLE public.user_security_preferences (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  inactivity_timeout_minutes INTEGER DEFAULT 5,
  pin_required_for_unlock BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE (user_id)
);

ALTER TABLE public.user_security_preferences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own security preferences"
  ON public.user_security_preferences FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own security preferences"
  ON public.user_security_preferences FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own security preferences"
  ON public.user_security_preferences FOR UPDATE
  USING (auth.uid() = user_id);

CREATE TRIGGER update_user_security_preferences_updated_at
  BEFORE UPDATE ON public.user_security_preferences
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();
