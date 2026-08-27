CREATE TYPE public.consolidation_elimination_class AS ENUM ('intercompany_balance', 'intercompany_trading');
CREATE TYPE public.consolidation_elimination_difference_policy AS ENUM ('refuse', 'post_difference');

CREATE TABLE public.consolidation_elimination_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  group_id uuid NOT NULL REFERENCES public.consolidation_groups(id) ON DELETE CASCADE,
  elimination_class public.consolidation_elimination_class NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  tolerance_amount numeric(18,2) NOT NULL DEFAULT 0 CHECK (tolerance_amount >= 0),
  difference_policy public.consolidation_elimination_difference_policy NOT NULL DEFAULT 'refuse',
  difference_group_account_id uuid REFERENCES public.consolidation_group_accounts(id) ON DELETE RESTRICT,
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (group_id, elimination_class)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.consolidation_elimination_rules TO authenticated;
GRANT ALL ON public.consolidation_elimination_rules TO service_role;
ALTER TABLE public.consolidation_elimination_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY consolidation_elimination_rules_select ON public.consolidation_elimination_rules
FOR SELECT TO authenticated
USING (
  public.is_org_member(auth.uid(), organization_id)
  AND EXISTS (
    SELECT 1 FROM public.consolidation_groups g
     WHERE g.id = consolidation_elimination_rules.group_id
       AND public.user_can_access_business(auth.uid(), g.parent_business_id)
  )
);

CREATE POLICY consolidation_elimination_rules_write ON public.consolidation_elimination_rules
FOR ALL TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.consolidation_groups g
     WHERE g.id = consolidation_elimination_rules.group_id
       AND public.user_can_access_business(auth.uid(), g.parent_business_id)
  )
  AND (public.has_org_role(auth.uid(), organization_id, 'owner'::public.app_role)
    OR public.has_org_role(auth.uid(), organization_id, 'admin'::public.app_role)
    OR public.has_org_role(auth.uid(), organization_id, 'super_admin'::public.app_role))
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.consolidation_groups g
     WHERE g.id = consolidation_elimination_rules.group_id
       AND public.user_can_access_business(auth.uid(), g.parent_business_id)
  )
  AND (public.has_org_role(auth.uid(), organization_id, 'owner'::public.app_role)
    OR public.has_org_role(auth.uid(), organization_id, 'admin'::public.app_role)
    OR public.has_org_role(auth.uid(), organization_id, 'super_admin'::public.app_role))
);

CREATE OR REPLACE FUNCTION public._consolidation_elimination_rule_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_group public.consolidation_groups;
BEGIN
  SELECT * INTO v_group FROM public.consolidation_groups g WHERE g.id = NEW.group_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Consolidation group not found';
  END IF;

  IF NEW.organization_id IS DISTINCT FROM v_group.organization_id THEN
    RAISE EXCEPTION 'Elimination rule organisation must match its consolidation group';
  END IF;

  IF NEW.difference_policy = 'post_difference' AND NEW.difference_group_account_id IS NULL THEN
    RAISE EXCEPTION 'A rule that posts the difference must name the group account that carries it';
  END IF;

  IF NEW.difference_group_account_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.consolidation_group_accounts a
        WHERE a.id = NEW.difference_group_account_id
          AND a.group_id = NEW.group_id
          AND a.is_active
     ) THEN
    RAISE EXCEPTION 'The difference account must be an active group account of the same consolidation group';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER consolidation_elimination_rule_guard
BEFORE INSERT OR UPDATE ON public.consolidation_elimination_rules
FOR EACH ROW EXECUTE FUNCTION public._consolidation_elimination_rule_guard();

CREATE TABLE public.consolidation_eliminations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  group_id uuid NOT NULL REFERENCES public.consolidation_groups(id) ON DELETE CASCADE,
  period_start date NOT NULL,
  period_end date NOT NULL,
  elimination_class public.consolidation_elimination_class NOT NULL,
  declaring_business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE RESTRICT,
  counterparty_business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE RESTRICT,
  group_account_id uuid NOT NULL,
  group_account_code text NOT NULL,
  group_account_name text NOT NULL,
  account_type public.account_type NOT NULL,
  presentation_currency text NOT NULL,
  debit numeric(18,2) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit numeric(18,2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  is_difference boolean NOT NULL DEFAULT false,
  source_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  generated_at timestamptz NOT NULL DEFAULT now(),
  generated_by uuid,
  CHECK (period_end >= period_start),
  CHECK (NOT (debit > 0 AND credit > 0))
);

CREATE INDEX consolidation_eliminations_period_idx
  ON public.consolidation_eliminations (group_id, period_start, period_end, elimination_class);
CREATE UNIQUE INDEX consolidation_eliminations_unique_line
  ON public.consolidation_eliminations (group_id, period_start, period_end, elimination_class,
                                        declaring_business_id, counterparty_business_id,
                                        group_account_id, is_difference);

GRANT SELECT ON public.consolidation_eliminations TO authenticated;
GRANT ALL ON public.consolidation_eliminations TO service_role;
ALTER TABLE public.consolidation_eliminations ENABLE ROW LEVEL SECURITY;

CREATE POLICY consolidation_eliminations_select ON public.consolidation_eliminations
FOR SELECT TO authenticated
USING (
  public.is_org_member(auth.uid(), organization_id)
  AND EXISTS (
    SELECT 1 FROM public.consolidation_groups g
     WHERE g.id = consolidation_eliminations.group_id
       AND public.user_can_access_business(auth.uid(), g.parent_business_id)
  )
);

CREATE OR REPLACE FUNCTION public._consolidation_eliminations_engine_only()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF COALESCE(current_setting('app.consolidation_elimination_engine', true), '') <> 'on' THEN
    RAISE EXCEPTION 'Eliminations are generated by the consolidation elimination engine and cannot be entered or edited by hand'
      USING ERRCODE = '42501';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER consolidation_eliminations_engine_only
BEFORE INSERT OR UPDATE OR DELETE ON public.consolidation_eliminations
FOR EACH ROW EXECUTE FUNCTION public._consolidation_eliminations_engine_only();