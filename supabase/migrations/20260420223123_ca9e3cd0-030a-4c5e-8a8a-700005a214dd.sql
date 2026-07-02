-- Fix existing orgs with incorrect localization_status.
-- Their CoA and tax rates were already provisioned by complete_onboarding RPC,
-- so 'failed' is misleading. Set to 'generic' (no pack installed, but system works).
UPDATE public.organizations 
SET localization_status = 'generic' 
WHERE localization_status IN ('failed', 'pending');

-- Also set the default for new orgs to 'generic' instead of 'pending'
-- since complete_onboarding already provisions CoA + tax rates.
ALTER TABLE public.organizations 
ALTER COLUMN localization_status SET DEFAULT 'generic';