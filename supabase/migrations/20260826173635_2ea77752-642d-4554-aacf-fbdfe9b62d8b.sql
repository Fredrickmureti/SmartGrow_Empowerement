CREATE TYPE public.consolidation_rate_type AS ENUM ('closing', 'average', 'historical');

CREATE TABLE public.consolidation_exchange_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  group_id uuid NOT NULL REFERENCES public.consolidation_groups(id) ON DELETE CASCADE,
  from_currency text NOT NULL,
  to_currency text NOT NULL,
  rate_type public.consolidation_rate_type NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  rate numeric(20,10) NOT NULL,
  source text NOT NULL DEFAULT 'manual',
  note text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT consolidation_rate_positive CHECK (rate > 0),
  CONSTRAINT consolidation_rate_period CHECK (period_end >= period_start),
  CONSTRAINT consolidation_rate_distinct_currencies CHECK (from_currency <> to_currency)
);

CREATE UNIQUE INDEX consolidation_exchange_rates_key
  ON public.consolidation_exchange_rates
  (group_id, from_currency, to_currency, rate_type, period_start, period_end);
CREATE INDEX consolidation_exchange_rates_lookup_idx
  ON public.consolidation_exchange_rates (group_id, period_end DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.consolidation_exchange_rates TO authenticated;
GRANT ALL ON public.consolidation_exchange_rates TO service_role;

ALTER TABLE public.consolidation_exchange_rates ENABLE ROW LEVEL SECURITY;

CREATE POLICY consolidation_exchange_rates_select ON public.consolidation_exchange_rates
  FOR SELECT TO authenticated
  USING (public.is_org_member(auth.uid(), organization_id)
         AND EXISTS (SELECT 1 FROM public.consolidation_groups g
                      WHERE g.id = group_id
                        AND public.user_can_access_business(auth.uid(), g.parent_business_id)));

CREATE POLICY consolidation_exchange_rates_write ON public.consolidation_exchange_rates
  FOR ALL TO authenticated
  USING (public.is_org_member(auth.uid(), organization_id)
         AND (public.has_org_role(auth.uid(), organization_id, 'owner'::app_role)
              OR public.has_org_role(auth.uid(), organization_id, 'admin'::app_role)
              OR public.has_org_role(auth.uid(), organization_id, 'super_admin'::app_role)))
  WITH CHECK (public.is_org_member(auth.uid(), organization_id)
         AND (public.has_org_role(auth.uid(), organization_id, 'owner'::app_role)
              OR public.has_org_role(auth.uid(), organization_id, 'admin'::app_role)
              OR public.has_org_role(auth.uid(), organization_id, 'super_admin'::app_role)));

CREATE OR REPLACE FUNCTION public._consolidation_rate_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_group record;
BEGIN
  SELECT * INTO v_group FROM public.consolidation_groups WHERE id = NEW.group_id;
  IF v_group.id IS NULL THEN
    RAISE EXCEPTION 'Consolidation group not found' USING ERRCODE = '23503';
  END IF;
  IF v_group.organization_id <> NEW.organization_id THEN
    RAISE EXCEPTION 'Rate organization must match the group organization' USING ERRCODE = '23514';
  END IF;
  IF NEW.to_currency <> v_group.presentation_currency THEN
    RAISE EXCEPTION 'Consolidation rates must translate into the group presentation currency (%)',
      v_group.presentation_currency USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.currencies WHERE code = NEW.from_currency) THEN
    RAISE EXCEPTION 'Unknown currency %', NEW.from_currency USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public._consolidation_rate_guard() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER consolidation_exchange_rates_guard
  BEFORE INSERT OR UPDATE ON public.consolidation_exchange_rates
  FOR EACH ROW EXECUTE FUNCTION public._consolidation_rate_guard();