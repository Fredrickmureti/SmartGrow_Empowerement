DO $$
DECLARE
  v_user uuid;
  v_org  uuid;
  v_biz  uuid;
BEGIN
  SELECT id INTO v_user FROM auth.users WHERE lower(email) = 'fredrickmureti612@gmail.com' LIMIT 1;

  SELECT id INTO v_org FROM public.organizations WHERE slug = 'smart-grow-empowerment';
  IF v_org IS NULL THEN
    INSERT INTO public.organizations (name, slug, owner_user_id, governance_mode)
    VALUES ('Smart Grow Empowerment', 'smart-grow-empowerment', v_user, 'single_company')
    RETURNING id INTO v_org;
  END IF;

  SELECT id INTO v_biz FROM public.businesses WHERE organization_id = v_org LIMIT 1;
  IF v_biz IS NULL THEN
    INSERT INTO public.businesses (organization_id, name, legal_name, country, base_currency, timezone, is_active)
    VALUES (v_org, 'Smart Grow Empowerment', 'Smart Grow Empowerment Limited', 'KE', 'KES', 'Africa/Nairobi', true)
    RETURNING id INTO v_biz;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.branches WHERE organization_id = v_org) THEN
    INSERT INTO public.branches (business_id, organization_id, name, code, is_headquarters, is_active)
    VALUES (v_biz, v_org, 'Head Office', 'HO', true, true);
  END IF;

  IF v_user IS NOT NULL THEN
    INSERT INTO public.user_roles (user_id, organization_id, role, user_type, is_active)
    VALUES (v_user, v_org, 'super_admin', 'internal', true)
    ON CONFLICT (user_id, organization_id) DO UPDATE SET role = 'super_admin', is_active = true, updated_at = now();

    UPDATE public.profiles SET last_org_id = v_org, updated_at = now() WHERE user_id = v_user;
  END IF;
END $$;