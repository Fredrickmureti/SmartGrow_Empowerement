-- Recreate AccrualFlow organization for fredrickmureti612@gmail.com
INSERT INTO public.organizations (id, name, slug, country, base_currency)
VALUES (
  gen_random_uuid(),
  'AccrualFlow',
  'accrualflow',
  'KE',
  'KES'
);

-- Create owner role for fredrickmureti612@gmail.com
INSERT INTO public.user_roles (user_id, organization_id, role, user_type)
VALUES (
  '4cf18944-4250-4199-af49-94bf32541fa7',
  (SELECT id FROM public.organizations WHERE slug = 'accrualflow'),
  'owner',
  'internal'
);