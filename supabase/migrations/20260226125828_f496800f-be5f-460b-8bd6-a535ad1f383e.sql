
-- Step 1: Create the RPC function for future-proofing
CREATE OR REPLACE FUNCTION public.get_or_create_default_business_for_org(_org_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  existing_biz_id UUID;
  new_biz_id UUID;
  org_rec RECORD;
  caller_id UUID;
BEGIN
  -- Check if a business already exists
  SELECT id INTO existing_biz_id
  FROM businesses
  WHERE organization_id = _org_id AND is_active = true
  LIMIT 1;

  IF existing_biz_id IS NOT NULL THEN
    -- Ensure caller has access
    caller_id := auth.uid();
    IF caller_id IS NOT NULL THEN
      INSERT INTO user_business_access (user_id, organization_id, business_id, is_primary, can_switch)
      VALUES (caller_id, _org_id, existing_biz_id, true, true)
      ON CONFLICT (user_id, business_id) DO NOTHING;
    END IF;
    RETURN existing_biz_id;
  END IF;

  -- Get org details
  SELECT id, name, country, base_currency INTO org_rec
  FROM organizations WHERE id = _org_id;

  IF org_rec.id IS NULL THEN
    RAISE EXCEPTION 'Organization not found';
  END IF;

  -- Create default business
  INSERT INTO businesses (organization_id, name, country, is_active, base_currency)
  VALUES (_org_id, org_rec.name, org_rec.country, true, COALESCE(org_rec.base_currency, 'USD'))
  RETURNING id INTO new_biz_id;

  -- Create user_business_access for all active users in the org
  INSERT INTO user_business_access (user_id, organization_id, business_id, is_primary, can_switch)
  SELECT ur.user_id, ur.organization_id, new_biz_id, true,
         (ur.role IN ('super_admin','owner','admin'))
  FROM user_roles ur
  WHERE ur.organization_id = _org_id AND ur.is_active = true
  ON CONFLICT (user_id, business_id) DO NOTHING;

  -- Fix orphan products
  UPDATE products SET business_id = new_biz_id
  WHERE organization_id = _org_id AND business_id IS NULL;

  RETURN new_biz_id;
END;
$$;

-- Step 2: Backfill existing orphan organizations
DO $$
DECLARE
  rec RECORD;
  new_biz_id UUID;
BEGIN
  FOR rec IN
    SELECT o.id as org_id, o.name, o.country, o.base_currency
    FROM organizations o
    WHERE NOT EXISTS (
      SELECT 1 FROM businesses b WHERE b.organization_id = o.id
    )
  LOOP
    INSERT INTO businesses (organization_id, name, country, is_active, base_currency)
    VALUES (rec.org_id, rec.name, rec.country, true, COALESCE(rec.base_currency, 'USD'))
    RETURNING id INTO new_biz_id;

    INSERT INTO user_business_access (user_id, organization_id, business_id, is_primary, can_switch)
    SELECT ur.user_id, ur.organization_id, new_biz_id, true,
           (ur.role IN ('super_admin','owner','admin'))
    FROM user_roles ur
    WHERE ur.organization_id = rec.org_id AND ur.is_active = true
    ON CONFLICT (user_id, business_id) DO NOTHING;

    UPDATE products SET business_id = new_biz_id
    WHERE organization_id = rec.org_id AND business_id IS NULL;
  END LOOP;
END $$;
