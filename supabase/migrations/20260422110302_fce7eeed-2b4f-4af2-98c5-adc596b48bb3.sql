INSERT INTO public.platform_admins (user_id, role, is_active, notes)
SELECT id, 'owner', true, 'Platform owner - seeded'
FROM auth.users
WHERE email = 'fredrickmureti612@gmail.com'
ON CONFLICT (user_id) DO UPDATE SET role = 'owner', is_active = true;