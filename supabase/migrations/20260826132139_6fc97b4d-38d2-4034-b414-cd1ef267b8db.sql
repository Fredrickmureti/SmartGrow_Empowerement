
CREATE OR REPLACE FUNCTION public.employees_sync_membership()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  IF NEW.user_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles
     WHERE user_id = NEW.user_id
       AND organization_id = NEW.organization_id
       AND is_active = true
  ) THEN
    -- Profiles is required by user_roles_profiles_fk. Create a stub if missing.
    -- profiles.email is NOT NULL, so the stub must carry an address: prefer the
    -- auth account's email, then the employee's work/personal email.
    INSERT INTO public.profiles (user_id, email, full_name)
    SELECT NEW.user_id,
           COALESCE((SELECT u.email FROM auth.users u WHERE u.id = NEW.user_id),
                    NEW.work_email, NEW.email,
                    NEW.user_id::text || '@placeholder.invalid'),
           NULLIF(TRIM(COALESCE(NEW.first_name,'') || ' ' || COALESCE(NEW.last_name,'')), '')
    WHERE NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.user_id = NEW.user_id);

    INSERT INTO public.user_roles (user_id, organization_id, role, user_type, is_active)
    VALUES (NEW.user_id, NEW.organization_id, 'portal'::public.app_role, 'portal', true)
    ON CONFLICT (user_id, organization_id) DO UPDATE
      SET is_active = true,
          updated_at = now();
  END IF;

  RETURN NEW;
END;
$fn$;
