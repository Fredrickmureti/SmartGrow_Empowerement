CREATE OR REPLACE FUNCTION public._consolidation_group_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_org uuid;
BEGIN
  SELECT organization_id INTO v_org FROM public.businesses WHERE id = NEW.parent_business_id;
  IF v_org IS NULL OR v_org <> NEW.organization_id THEN
    RAISE EXCEPTION 'Parent company must belong to the same organization'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.currencies WHERE code = NEW.presentation_currency) THEN
    RAISE EXCEPTION 'Unknown presentation currency %', NEW.presentation_currency
      USING ERRCODE = '23514';
  END IF;

  -- The presentation currency is a reporting currency of the parent company: it must be
  -- one the parent actually operates in (Step 6 operating-currency contract), otherwise
  -- the group could be denominated in a currency the parent may not transact in.
  IF NOT EXISTS (
    SELECT 1 FROM public.business_active_currencies bac
     WHERE bac.business_id = NEW.parent_business_id
       AND bac.currency_code = NEW.presentation_currency
       AND bac.is_enabled
  ) THEN
    RAISE EXCEPTION 'Presentation currency % is not an enabled operating currency of the parent company', NEW.presentation_currency
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.created_by := auth.uid();
  ELSE
    NEW.created_by := OLD.created_by;
    NEW.organization_id := OLD.organization_id;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;