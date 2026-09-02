CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_exists boolean := false;
BEGIN
  IF _user_id IS NULL OR _role IS NULL OR _role = '' THEN
    RETURN false;
  END IF;

  BEGIN
    IF public.is_platform_admin(_user_id) THEN
      RETURN true;
    END IF;
  EXCEPTION WHEN undefined_function THEN
    NULL;
  END;

  SELECT EXISTS (
    SELECT 1
      FROM public.user_roles ur
     WHERE ur.user_id = _user_id
       AND ur.is_active = true
       AND ur.role::text = _role
  ) INTO v_exists;

  IF v_exists THEN
    RETURN true;
  END IF;

  -- Single-institution model: the owner account is the institution's
  -- highest authority and satisfies super_admin / admin requirements.
  IF _role IN ('super_admin', 'admin') THEN
    SELECT EXISTS (
      SELECT 1
        FROM public.user_roles ur
       WHERE ur.user_id = _user_id
         AND ur.is_active = true
         AND ur.role::text = 'owner'
    ) INTO v_exists;
  END IF;

  RETURN v_exists;
END;
$function$;