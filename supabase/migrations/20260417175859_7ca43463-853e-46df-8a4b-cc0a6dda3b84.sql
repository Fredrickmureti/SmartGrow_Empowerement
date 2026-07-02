-- Fix 1: Reload PostgREST schema cache so existing RPCs (e.g. get_sales_dashboard_kpis) resolve
NOTIFY pgrst, 'reload schema';

-- Fix 2: Create user_command_preferences table
CREATE TABLE IF NOT EXISTS public.user_command_preferences (
  user_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  pinned jsonb NOT NULL DEFAULT '[]'::jsonb,
  usage jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, organization_id)
);

ALTER TABLE public.user_command_preferences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own command preferences"
  ON public.user_command_preferences
  FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own command preferences"
  ON public.user_command_preferences
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own command preferences"
  ON public.user_command_preferences
  FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own command preferences"
  ON public.user_command_preferences
  FOR DELETE
  USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.update_user_command_preferences_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_user_command_preferences_updated_at ON public.user_command_preferences;
CREATE TRIGGER trg_user_command_preferences_updated_at
  BEFORE UPDATE ON public.user_command_preferences
  FOR EACH ROW
  EXECUTE FUNCTION public.update_user_command_preferences_updated_at();

-- Reload again after DDL so the new table is in the REST schema immediately
NOTIFY pgrst, 'reload schema';