INSERT INTO public.plan_app_access (plan_id, app_id, is_enabled)
SELECT id, 'talent', true FROM public.platform_subscription_plans
WHERE name IN ('Business', 'Enterprise')
ON CONFLICT DO NOTHING;