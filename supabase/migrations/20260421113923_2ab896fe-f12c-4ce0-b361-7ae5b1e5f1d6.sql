
-- WAVE B.1: Re-parent localization packs to Company
ALTER TABLE public.installed_localization_packs
  ADD COLUMN IF NOT EXISTS business_id uuid;

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.installed_localization_packs'::regclass
      AND contype = 'u'
  LOOP
    EXECUTE format('ALTER TABLE public.installed_localization_packs DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

UPDATE public.installed_localization_packs ilp
SET business_id = (
  SELECT b.id FROM public.businesses b
  WHERE b.organization_id = ilp.organization_id
    AND COALESCE(b.is_active, true) = true
  ORDER BY b.created_at ASC
  LIMIT 1
)
WHERE business_id IS NULL;

ALTER TABLE public.installed_localization_packs
  ALTER COLUMN business_id SET NOT NULL;

ALTER TABLE public.installed_localization_packs
  ADD CONSTRAINT installed_localization_packs_business_id_fkey
  FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS installed_localization_packs_business_unique
  ON public.installed_localization_packs(business_id);

CREATE INDEX IF NOT EXISTS idx_installed_localization_packs_business
  ON public.installed_localization_packs(business_id);

-- WAVE B.2: business_active_currencies
CREATE TABLE IF NOT EXISTS public.business_active_currencies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  currency_code text NOT NULL,
  is_enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  UNIQUE(business_id, currency_code)
);

CREATE INDEX IF NOT EXISTS idx_business_active_currencies_business
  ON public.business_active_currencies(business_id) WHERE is_enabled = true;

ALTER TABLE public.business_active_currencies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can view active currencies" ON public.business_active_currencies;
CREATE POLICY "Members can view active currencies"
  ON public.business_active_currencies FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.organization_id = business_active_currencies.organization_id
        AND ur.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Admins can manage active currencies" ON public.business_active_currencies;
CREATE POLICY "Admins can manage active currencies"
  ON public.business_active_currencies FOR ALL
  USING (
    public.has_org_role(auth.uid(), business_active_currencies.organization_id, 'owner'::public.app_role)
    OR public.has_org_role(auth.uid(), business_active_currencies.organization_id, 'admin'::public.app_role)
    OR public.has_org_role(auth.uid(), business_active_currencies.organization_id, 'super_admin'::public.app_role)
  )
  WITH CHECK (
    public.has_org_role(auth.uid(), business_active_currencies.organization_id, 'owner'::public.app_role)
    OR public.has_org_role(auth.uid(), business_active_currencies.organization_id, 'admin'::public.app_role)
    OR public.has_org_role(auth.uid(), business_active_currencies.organization_id, 'super_admin'::public.app_role)
  );

-- WAVE B.3: Relax bank-account currency trigger
CREATE OR REPLACE FUNCTION public.enforce_bank_account_currency()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_base_currency text;
  v_is_active_currency boolean;
BEGIN
  IF NEW.currency IS NULL THEN
    SELECT base_currency INTO NEW.currency
    FROM public.businesses WHERE id = NEW.business_id;
    RETURN NEW;
  END IF;

  SELECT base_currency INTO v_base_currency
  FROM public.businesses WHERE id = NEW.business_id;

  IF v_base_currency IS NULL THEN RETURN NEW; END IF;
  IF NEW.currency = v_base_currency THEN RETURN NEW; END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.business_active_currencies
    WHERE business_id = NEW.business_id
      AND currency_code = NEW.currency
      AND is_enabled = true
  ) INTO v_is_active_currency;

  IF NOT v_is_active_currency THEN
    RAISE EXCEPTION
      'Bank account currency % is not enabled for this Company. Base currency is %. Add % to the Company''s active currencies first.',
      NEW.currency, v_base_currency, NEW.currency
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$function$;
