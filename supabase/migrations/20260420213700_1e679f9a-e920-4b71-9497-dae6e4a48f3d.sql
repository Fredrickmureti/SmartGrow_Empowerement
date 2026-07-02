-- Fix live onboarding fiscal-period provisioning contract.
CREATE OR REPLACE FUNCTION public.provision_default_fiscal_periods(_org_id uuid, _business_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _year integer := EXTRACT(YEAR FROM CURRENT_DATE)::integer;
  _year_start date := make_date(_year, 1, 1);
  _year_end date := make_date(_year, 12, 31);
  _i integer;
  _ms date;
  _me date;
  _count integer := 0;
  _inserted integer := 0;
BEGIN
  IF _org_id IS NULL OR _business_id IS NULL THEN
    RAISE EXCEPTION 'organization_id and business_id are required';
  END IF;

  INSERT INTO public.fiscal_periods (
    organization_id, business_id, name, period_type, start_date, end_date, status
  )
  VALUES (
    _org_id, _business_id, 'FY ' || _year::text, 'year', _year_start, _year_end, 'open'
  )
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS _inserted = ROW_COUNT;
  _count := _count + _inserted;

  FOR _i IN 1..12 LOOP
    _ms := make_date(_year, _i, 1);
    _me := (_ms + INTERVAL '1 month' - INTERVAL '1 day')::date;

    INSERT INTO public.fiscal_periods (
      organization_id, business_id, name, period_type, start_date, end_date, status
    )
    VALUES (
      _org_id, _business_id, to_char(_ms, 'Mon YYYY'), 'month', _ms, _me, 'open'
    )
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS _inserted = ROW_COUNT;
    _count := _count + _inserted;
  END LOOP;

  RETURN _count;
END;
$$;

-- Server-side signup/onboarding progress state for recovery and diagnostics.
CREATE TABLE IF NOT EXISTS public.onboarding_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  idempotency_key text,
  status text NOT NULL DEFAULT 'started',
  company_name text,
  country text,
  currency text,
  organization_id uuid REFERENCES public.organizations(id) ON DELETE SET NULL,
  business_id uuid REFERENCES public.businesses(id) ON DELETE SET NULL,
  error_message text,
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT onboarding_attempts_status_check CHECK (status IN (
    'started', 'provisioning_org', 'provisioning_company', 'installing_apps',
    'sending_invites', 'completed', 'failed'
  )),
  CONSTRAINT onboarding_attempts_user_id_idempotency_key_key UNIQUE (user_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_onboarding_attempts_user_status
  ON public.onboarding_attempts(user_id, status, updated_at DESC);

ALTER TABLE public.onboarding_attempts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view their own onboarding attempts" ON public.onboarding_attempts;
CREATE POLICY "Users can view their own onboarding attempts"
ON public.onboarding_attempts
FOR SELECT
TO authenticated
USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can create their own onboarding attempts" ON public.onboarding_attempts;
CREATE POLICY "Users can create their own onboarding attempts"
ON public.onboarding_attempts
FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update their own onboarding attempts" ON public.onboarding_attempts;
CREATE POLICY "Users can update their own onboarding attempts"
ON public.onboarding_attempts
FOR UPDATE
TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.touch_onboarding_attempts_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_touch_onboarding_attempts_updated_at ON public.onboarding_attempts;
CREATE TRIGGER trg_touch_onboarding_attempts_updated_at
BEFORE UPDATE ON public.onboarding_attempts
FOR EACH ROW
EXECUTE FUNCTION public.touch_onboarding_attempts_updated_at();

-- Lightweight database contract check used after deploys/audits.
CREATE OR REPLACE FUNCTION public.verify_onboarding_contract()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _fn text;
  _bad_periods integer;
BEGIN
  SELECT pg_get_functiondef(p.oid)
    INTO _fn
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'provision_default_fiscal_periods'
  LIMIT 1;

  SELECT count(*) INTO _bad_periods
  FROM public.fiscal_periods
  WHERE period_type NOT IN ('month', 'quarter', 'year');

  RETURN jsonb_build_object(
    'ok', COALESCE(_fn NOT ILIKE '%annual%' AND _fn NOT ILIKE '%monthly%', false) AND _bad_periods = 0,
    'provision_function_uses_valid_period_types', COALESCE(_fn NOT ILIKE '%annual%' AND _fn NOT ILIKE '%monthly%', false),
    'invalid_existing_fiscal_periods', _bad_periods,
    'allowed_period_types', jsonb_build_array('month', 'quarter', 'year')
  );
END;
$$;