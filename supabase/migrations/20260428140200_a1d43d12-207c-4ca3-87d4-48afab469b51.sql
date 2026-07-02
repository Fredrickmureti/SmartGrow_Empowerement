-- Defect 1: Drop vestigial 3-arg overload of seed_app_data that causes
-- "function public.seed_app_data(uuid, text) is not unique" (SQLSTATE 42725)
-- The 3-arg version had `p_business_id uuid DEFAULT NULL`, which made every
-- 2-arg call (the only call shape used in install_app and complete_onboarding)
-- ambiguous. The canonical 2-arg version is preserved untouched.
DROP FUNCTION IF EXISTS public.seed_app_data(uuid, text, uuid);

COMMENT ON FUNCTION public.seed_app_data(uuid, text) IS
  'Canonical app post-install seeder. DO NOT add overloads — install_app() and complete_onboarding() call this with exactly 2 args (org_id, app_id). Adding a 3-arg overload with a default re-creates the 42725 ambiguity that broke every app install.';

-- Defect 2: Free plan was internally contradictory — 7 apps marked
-- in-plan via plan_app_access but max_installed_apps=1 silently blocked
-- the 2nd install under per-user billing. Aligning Free with Growth /
-- Business / Enterprise (all NULL = uncapped). Add-ons (POS, HR, CRM,
-- Projects, Sign, Documents, SMS) remain reachable via the existing
-- 14-day trial flow in useAppLifecycle.
UPDATE public.platform_subscription_plans
   SET max_installed_apps = NULL
 WHERE name = 'Free' AND max_installed_apps IS NOT NULL;