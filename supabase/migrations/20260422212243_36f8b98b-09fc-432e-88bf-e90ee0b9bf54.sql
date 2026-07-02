CREATE OR REPLACE FUNCTION public.resolve_pos_setting(
  _business_id uuid,
  _branch_id uuid,
  _register_id uuid,
  _setting_key text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_value jsonb;
BEGIN
  IF _business_id IS NULL OR _setting_key IS NULL THEN
    RETURN NULL;
  END IF;

  -- 1) Register-specific
  IF _register_id IS NOT NULL THEN
    SELECT setting_value INTO v_value
    FROM public.pos_settings
    WHERE business_id = _business_id
      AND setting_key = _setting_key
      AND register_id = _register_id
    LIMIT 1;
    IF v_value IS NOT NULL THEN RETURN v_value; END IF;
  END IF;

  -- 2) Branch-specific (no register)
  IF _branch_id IS NOT NULL THEN
    SELECT setting_value INTO v_value
    FROM public.pos_settings
    WHERE business_id = _business_id
      AND setting_key = _setting_key
      AND branch_id = _branch_id
      AND register_id IS NULL
    LIMIT 1;
    IF v_value IS NOT NULL THEN RETURN v_value; END IF;
  END IF;

  -- 3) Company-wide default
  SELECT setting_value INTO v_value
  FROM public.pos_settings
  WHERE business_id = _business_id
    AND setting_key = _setting_key
    AND register_id IS NULL
    AND branch_id IS NULL
  LIMIT 1;

  RETURN v_value;
END;
$$;

GRANT EXECUTE ON FUNCTION public.resolve_pos_setting(uuid, uuid, uuid, text) TO authenticated;