-- Make POS manager PIN functions company-scoped and compatible with business_id NOT NULL

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'pos_manager_pins_organization_id_user_id_key'
      AND conrelid = 'public.pos_manager_pins'::regclass
  ) THEN
    ALTER TABLE public.pos_manager_pins
      DROP CONSTRAINT pos_manager_pins_organization_id_user_id_key;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS pos_manager_pins_org_business_user_uidx
ON public.pos_manager_pins (organization_id, business_id, user_id);

CREATE OR REPLACE FUNCTION public.set_manager_pin(
  p_organization_id uuid,
  p_business_id uuid,
  p_user_id uuid,
  p_pin text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
  IF p_organization_id IS NULL OR p_business_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'Organization, company, and user are required';
  END IF;

  IF p_pin IS NULL OR length(p_pin) < 4 THEN
    RAISE EXCEPTION 'Manager PIN must be at least 4 digits';
  END IF;

  INSERT INTO public.pos_manager_pins (organization_id, business_id, user_id, pin_hash, is_active)
  VALUES (p_organization_id, p_business_id, p_user_id, crypt(p_pin, gen_salt('bf')), true)
  ON CONFLICT (organization_id, business_id, user_id)
  DO UPDATE SET
    pin_hash = crypt(p_pin, gen_salt('bf')),
    is_active = true,
    updated_at = now();

  RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION public.verify_manager_pin(
  p_organization_id uuid,
  p_business_id uuid,
  p_manager_id uuid,
  p_pin text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_pin_hash text;
  v_is_active boolean;
  v_has_role boolean;
BEGIN
  IF p_organization_id IS NULL OR p_business_id IS NULL OR p_manager_id IS NULL OR p_pin IS NULL THEN
    RETURN false;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles
    WHERE user_id = p_manager_id
      AND role IN ('owner', 'admin', 'super_admin')
  ) INTO v_has_role;

  IF NOT v_has_role THEN
    RETURN false;
  END IF;

  SELECT pin_hash, is_active
  INTO v_pin_hash, v_is_active
  FROM public.pos_manager_pins
  WHERE organization_id = p_organization_id
    AND business_id = p_business_id
    AND user_id = p_manager_id;

  IF NOT FOUND OR NOT v_is_active THEN
    RETURN false;
  END IF;

  RETURN v_pin_hash = crypt(p_pin, v_pin_hash);
END;
$function$;