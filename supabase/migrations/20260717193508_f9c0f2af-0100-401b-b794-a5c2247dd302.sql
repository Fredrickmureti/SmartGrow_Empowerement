
-- Register warehouse app in platform_apps catalog
INSERT INTO public.platform_apps (id, name, description, category, required_plan, sort_order, is_available, is_visible_in_signup)
VALUES ('warehouse', 'Warehouse', 'Operator tasks, receiving, put-away, picking, packing, dispatch', 'operations', 'professional', 55, true, true)
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description;

-- Add missing entitlements to Enterprise plan (all apps)
INSERT INTO public.plan_app_access (plan_id, app_id)
SELECT '2e45711a-cdae-43ee-97a1-138c83010206'::uuid, app_id
FROM (VALUES ('timesheets'), ('warehouse')) AS t(app_id)
ON CONFLICT DO NOTHING;

-- Business plan gets timesheets + warehouse too
INSERT INTO public.plan_app_access (plan_id, app_id)
SELECT '3e4fbab0-3652-43c7-85db-f2dbe0d66884'::uuid, app_id
FROM (VALUES ('timesheets'), ('warehouse'), ('recruitment')) AS t(app_id)
ON CONFLICT DO NOTHING;
