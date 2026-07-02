-- Batch 2: Remove the legacy `hr` bundle app from the catalog and plan entitlements.
-- Pre-checked: no rows in organization_installed_apps reference 'hr'.

DELETE FROM public.plan_app_access WHERE app_id = 'hr';
DELETE FROM public.platform_apps   WHERE id     = 'hr';
