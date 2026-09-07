UPDATE public.organization_installed_apps
SET is_active = false, updated_at = now()
WHERE app_id IN ('sales', 'purchases') AND is_active = true;