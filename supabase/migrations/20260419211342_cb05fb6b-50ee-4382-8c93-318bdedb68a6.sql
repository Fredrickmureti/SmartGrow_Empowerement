-- Phase 3 Reset: Wipe all onboarding metadata so users are forced through signup/onboarding again.
-- Database is already empty (0 orgs, 0 businesses, 0 apps), but auth.users metadata still
-- says onboarding_completed=true, which causes Index.tsx to redirect into a headless dashboard
-- and creates a perceived infinite reload. Clearing metadata sends users to /onboarding-setup.

UPDATE auth.users
SET raw_user_meta_data = COALESCE(raw_user_meta_data, '{}'::jsonb)
  - 'onboarding_completed'
  - 'pending_business_name'
  - 'pending_company_name'
  - 'pending_country'
  - 'pending_currency'
  - 'pending_business_type'
  - 'pending_is_multi_business'
  - 'pending_legal_name'
WHERE raw_user_meta_data ? 'onboarding_completed'
   OR raw_user_meta_data ? 'pending_business_name'
   OR raw_user_meta_data ? 'pending_company_name'
   OR raw_user_meta_data ? 'pending_country'
   OR raw_user_meta_data ? 'pending_currency'
   OR raw_user_meta_data ? 'pending_business_type'
   OR raw_user_meta_data ? 'pending_is_multi_business'
   OR raw_user_meta_data ? 'pending_legal_name';