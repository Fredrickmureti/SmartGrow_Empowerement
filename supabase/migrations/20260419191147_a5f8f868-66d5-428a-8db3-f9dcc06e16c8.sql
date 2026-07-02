
CREATE OR REPLACE FUNCTION public.ensure_org_has_business(
  _org_id uuid,
  _country text DEFAULT NULL,
  _currency text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  existing_business_id UUID;
  new_business_id UUID;
  org_name TEXT;
  resolved_country TEXT;
  resolved_currency TEXT;
BEGIN
  SELECT id INTO existing_business_id
  FROM public.businesses
  WHERE organization_id = _org_id AND is_active = true
  LIMIT 1;

  IF existing_business_id IS NOT NULL THEN
    RETURN existing_business_id;
  END IF;

  SELECT name INTO org_name FROM public.organizations WHERE id = _org_id;

  SELECT country, base_currency
    INTO resolved_country, resolved_currency
    FROM public.businesses
   WHERE organization_id = _org_id
   ORDER BY created_at ASC
   LIMIT 1;

  resolved_country  := COALESCE(resolved_country,  _country,  'US');
  resolved_currency := COALESCE(resolved_currency, _currency, 'USD');

  INSERT INTO public.businesses (organization_id, name, country, is_active, base_currency)
  VALUES (_org_id, COALESCE(org_name, 'Default Business'), resolved_country, true, resolved_currency)
  RETURNING id INTO new_business_id;

  INSERT INTO public.branches (organization_id, business_id, name, is_headquarters, is_active)
  VALUES (_org_id, new_business_id, 'Main Branch', true, true);

  RETURN new_business_id;
END;
$function$;


CREATE OR REPLACE FUNCTION public.get_or_create_default_business_for_org(
  _org_id uuid,
  _country text DEFAULT NULL,
  _currency text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  existing_biz_id UUID;
  new_biz_id UUID;
  org_name TEXT;
  caller_id UUID;
  resolved_country TEXT;
  resolved_currency TEXT;
BEGIN
  SELECT id INTO existing_biz_id
  FROM businesses
  WHERE organization_id = _org_id AND is_active = true
  LIMIT 1;

  IF existing_biz_id IS NOT NULL THEN
    caller_id := auth.uid();
    IF caller_id IS NOT NULL THEN
      INSERT INTO user_business_access (user_id, organization_id, business_id, is_primary, can_switch)
      VALUES (caller_id, _org_id, existing_biz_id, true, true)
      ON CONFLICT (user_id, business_id) DO NOTHING;
    END IF;
    RETURN existing_biz_id;
  END IF;

  SELECT name INTO org_name FROM organizations WHERE id = _org_id;
  IF org_name IS NULL THEN
    RAISE EXCEPTION 'Organization not found';
  END IF;

  SELECT country, base_currency
    INTO resolved_country, resolved_currency
    FROM businesses
   WHERE organization_id = _org_id
   ORDER BY created_at ASC
   LIMIT 1;

  resolved_country  := COALESCE(resolved_country,  _country,  'US');
  resolved_currency := COALESCE(resolved_currency, _currency, 'USD');

  INSERT INTO businesses (organization_id, name, country, is_active, base_currency)
  VALUES (_org_id, org_name, resolved_country, true, resolved_currency)
  RETURNING id INTO new_biz_id;

  INSERT INTO branches (organization_id, business_id, name, is_headquarters, is_active)
  SELECT _org_id, new_biz_id, 'Main Branch', true, true
  WHERE NOT EXISTS (
    SELECT 1 FROM branches WHERE business_id = new_biz_id
  );

  INSERT INTO user_business_access (user_id, organization_id, business_id, is_primary, can_switch)
  SELECT ur.user_id, ur.organization_id, new_biz_id, true,
         (ur.role IN ('super_admin','owner','admin'))
  FROM user_roles ur
  WHERE ur.organization_id = _org_id AND ur.is_active = true
  ON CONFLICT (user_id, business_id) DO NOTHING;

  UPDATE products SET business_id = new_biz_id
  WHERE organization_id = _org_id AND business_id IS NULL;

  RETURN new_biz_id;
END;
$function$;


CREATE OR REPLACE FUNCTION public.lock_business_currency_after_je()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.base_currency IS DISTINCT FROM OLD.base_currency THEN
    IF EXISTS (
      SELECT 1 FROM public.journal_entries
       WHERE business_id = OLD.id
       LIMIT 1
    ) THEN
      RAISE EXCEPTION
        'Cannot change base_currency for business % — journal entries already exist. Currency is immutable after first posting.',
        OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_business_currency_lock ON public.businesses;
CREATE TRIGGER trg_business_currency_lock
  BEFORE UPDATE OF base_currency ON public.businesses
  FOR EACH ROW
  EXECUTE FUNCTION public.lock_business_currency_after_je();


CREATE OR REPLACE FUNCTION public.assert_branch_org_matches_business()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  biz_org_id UUID;
BEGIN
  IF NEW.business_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT organization_id INTO biz_org_id
    FROM public.businesses
   WHERE id = NEW.business_id;

  IF biz_org_id IS NULL THEN
    RAISE EXCEPTION 'Branch references unknown business_id %', NEW.business_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF NEW.organization_id IS DISTINCT FROM biz_org_id THEN
    RAISE EXCEPTION
      'Branch organization_id (%) must match its business organization_id (%)',
      NEW.organization_id, biz_org_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_branch_org_consistency ON public.branches;
CREATE TRIGGER trg_branch_org_consistency
  BEFORE INSERT OR UPDATE OF organization_id, business_id ON public.branches
  FOR EACH ROW
  EXECUTE FUNCTION public.assert_branch_org_matches_business();


CREATE OR REPLACE FUNCTION public.assert_je_business_belongs_to_org()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  biz_org_id UUID;
BEGIN
  IF NEW.business_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT organization_id INTO biz_org_id
    FROM public.businesses
   WHERE id = NEW.business_id;

  IF biz_org_id IS NULL THEN
    RAISE EXCEPTION 'Journal entry references unknown business_id %', NEW.business_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF biz_org_id IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION
      'Journal entry business_id (%) does not belong to organization_id (%) — cross-org posting is forbidden',
      NEW.business_id, NEW.organization_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_je_business_in_org ON public.journal_entries;
CREATE TRIGGER trg_je_business_in_org
  BEFORE INSERT OR UPDATE OF organization_id, business_id ON public.journal_entries
  FOR EACH ROW
  EXECUTE FUNCTION public.assert_je_business_belongs_to_org();


CREATE TABLE IF NOT EXISTS public.identity_drift_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ran_at timestamptz NOT NULL DEFAULT now(),
  org_name_drift_count integer NOT NULL DEFAULT 0,
  multi_business_org_count integer NOT NULL DEFAULT 0,
  branch_org_mismatch_count integer NOT NULL DEFAULT 0,
  details jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.identity_drift_reports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Super admins can view identity drift reports" ON public.identity_drift_reports;
CREATE POLICY "Super admins can view identity drift reports"
  ON public.identity_drift_reports
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid()
        AND role = 'super_admin'
        AND is_active = true
    )
  );

DROP POLICY IF EXISTS "Service role can write identity drift reports" ON public.identity_drift_reports;
CREATE POLICY "Service role can write identity drift reports"
  ON public.identity_drift_reports
  FOR INSERT
  TO service_role
  WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_identity_drift_reports_ran_at
  ON public.identity_drift_reports(ran_at DESC);
