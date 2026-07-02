-- Stop forcing platform admins through the customer onboarding wizard.
-- Platform admins are SaaS operators, not tenant customers; the
-- `onboarding_completed` flag on auth.users.user_metadata is used by legacy
-- frontend redirect paths to decide whether to show the workspace setup
-- wizard. For platform admins, that flag must be true (or absent) so they
-- can sign in and land on /admin-management directly.

UPDATE auth.users u
SET raw_user_meta_data = COALESCE(u.raw_user_meta_data, '{}'::jsonb)
                         || jsonb_build_object('onboarding_completed', true)
WHERE EXISTS (
  SELECT 1
  FROM public.platform_admins pa
  WHERE pa.user_id = u.id
    AND pa.is_active = true
)
AND COALESCE((u.raw_user_meta_data ->> 'onboarding_completed')::boolean, false) IS DISTINCT FROM true;
