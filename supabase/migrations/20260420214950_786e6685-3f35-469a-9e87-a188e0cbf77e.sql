DO $$
DECLARE
  _emails text[] := ARRAY['fredrickmureti612@gmail.com', 'devmuret@gmail.com'];
  _user_ids uuid[];
BEGIN
  SELECT array_agg(id) INTO _user_ids
  FROM auth.users
  WHERE lower(email) = ANY(_emails);

  IF _user_ids IS NULL THEN
    RETURN;
  END IF;

  ALTER TABLE public.user_roles DISABLE TRIGGER trg_enforce_owner_immutability_del;
  ALTER TABLE public.user_roles DISABLE TRIGGER trg_enforce_owner_immutability_upd;
  ALTER TABLE public.user_roles DISABLE TRIGGER refresh_user_counter_trigger;
  ALTER TABLE public.user_roles DISABLE TRIGGER track_user_usage_trigger;
  ALTER TABLE public.businesses DISABLE TRIGGER trg_prevent_last_business_delete;
  ALTER TABLE public.businesses DISABLE TRIGGER trg_prevent_last_business_deactivate;

  DELETE FROM public.onboarding_attempts WHERE user_id = ANY(_user_ids);
  DELETE FROM public.user_business_access WHERE user_id = ANY(_user_ids);
  DELETE FROM public.employees WHERE user_id = ANY(_user_ids);

  DELETE FROM public.organizations
  WHERE owner_user_id = ANY(_user_ids);

  DELETE FROM public.user_roles WHERE user_id = ANY(_user_ids);
  DELETE FROM public.profiles WHERE user_id = ANY(_user_ids);

  ALTER TABLE public.businesses ENABLE TRIGGER trg_prevent_last_business_delete;
  ALTER TABLE public.businesses ENABLE TRIGGER trg_prevent_last_business_deactivate;
  ALTER TABLE public.user_roles ENABLE TRIGGER refresh_user_counter_trigger;
  ALTER TABLE public.user_roles ENABLE TRIGGER track_user_usage_trigger;
  ALTER TABLE public.user_roles ENABLE TRIGGER trg_enforce_owner_immutability_del;
  ALTER TABLE public.user_roles ENABLE TRIGGER trg_enforce_owner_immutability_upd;

  DELETE FROM auth.users
  WHERE id = ANY(_user_ids)
    AND lower(email) = ANY(_emails);
EXCEPTION WHEN OTHERS THEN
  ALTER TABLE public.businesses ENABLE TRIGGER trg_prevent_last_business_delete;
  ALTER TABLE public.businesses ENABLE TRIGGER trg_prevent_last_business_deactivate;
  ALTER TABLE public.user_roles ENABLE TRIGGER refresh_user_counter_trigger;
  ALTER TABLE public.user_roles ENABLE TRIGGER track_user_usage_trigger;
  ALTER TABLE public.user_roles ENABLE TRIGGER trg_enforce_owner_immutability_del;
  ALTER TABLE public.user_roles ENABLE TRIGGER trg_enforce_owner_immutability_upd;
  RAISE;
END $$;