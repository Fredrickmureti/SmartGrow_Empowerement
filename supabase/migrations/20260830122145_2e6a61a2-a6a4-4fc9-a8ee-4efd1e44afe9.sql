-- Retire the SaaS billing / trial / plan-limit surface. None of these are
-- referenced by application code or by other database functions.

DROP TRIGGER IF EXISTS trg_sync_install_lifecycle ON public.app_trial_status;

DROP FUNCTION IF EXISTS public.sync_install_lifecycle_on_trial_change() CASCADE;
DROP FUNCTION IF EXISTS public.compute_org_billing(uuid, text) CASCADE;
DROP FUNCTION IF EXISTS public.compute_org_billing_for_plan(uuid, uuid, text) CASCADE;
DROP FUNCTION IF EXISTS public.check_downgrade_impact(uuid, uuid) CASCADE;
DROP FUNCTION IF EXISTS public.get_recent_plan_change_summary(uuid) CASCADE;
DROP FUNCTION IF EXISTS public.get_public_pricing_snapshot() CASCADE;
DROP FUNCTION IF EXISTS public.convert_app_trials_on_plan_change() CASCADE;
DROP FUNCTION IF EXISTS public.disable_expired_app_trials() CASCADE;
DROP FUNCTION IF EXISTS public.expire_app_trials() CASCADE;
DROP FUNCTION IF EXISTS public.extend_app_trial(uuid, text, integer) CASCADE;
DROP FUNCTION IF EXISTS public.start_app_trial(uuid, text) CASCADE;
DROP FUNCTION IF EXISTS public.is_app_trialable(text) CASCADE;
DROP FUNCTION IF EXISTS public.is_app_trialable_for(uuid, text) CASCADE;
DROP FUNCTION IF EXISTS public.grant_app_override(uuid, text, timestamptz, text) CASCADE;
DROP FUNCTION IF EXISTS public.revoke_app_override(uuid, text) CASCADE;
DROP FUNCTION IF EXISTS public.check_user_limit(uuid) CASCADE;
DROP FUNCTION IF EXISTS public.check_user_org_limit(uuid) CASCADE;
DROP FUNCTION IF EXISTS public.check_org_business_limit(uuid) CASCADE;
DROP FUNCTION IF EXISTS public.check_business_branch_limit(uuid) CASCADE;
DROP FUNCTION IF EXISTS public.check_storage_limit(uuid, numeric) CASCADE;