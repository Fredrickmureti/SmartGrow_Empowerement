DROP FUNCTION IF EXISTS public.check_storage_limit(uuid) CASCADE;
DROP FUNCTION IF EXISTS public.convert_app_trials_on_plan_change(uuid) CASCADE;
DROP FUNCTION IF EXISTS public.grant_app_override(uuid, text, text, timestamptz) CASCADE;
DROP FUNCTION IF EXISTS public.start_app_trial(uuid, text, integer) CASCADE;

DROP TRIGGER IF EXISTS track_user_usage_trigger ON public.user_roles;
DROP FUNCTION IF EXISTS public.track_user_usage() CASCADE;