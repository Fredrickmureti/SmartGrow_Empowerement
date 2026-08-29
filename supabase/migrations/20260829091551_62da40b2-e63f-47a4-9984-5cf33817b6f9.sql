-- ---------------------------------------------------------------------------
-- T3: the elimination tolerance becomes a governed control, not a literal.
-- ---------------------------------------------------------------------------

-- A rounding bound expressed in the currency it is measured in. 100 KES and
-- 100 JPY are not the same quantity of rounding; the bound scales with the
-- currency's minor unit instead of pretending they are.
CREATE OR REPLACE FUNCTION public.consolidation_tolerance_rounding_bound(_currency text)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT round(
    100 * power(
      10::numeric,
      2 - COALESCE((SELECT c.decimal_places FROM public.currencies c
                     WHERE upper(c.code) = upper(COALESCE(_currency, ''))), 2)
    ), 2);
$$;

DROP FUNCTION IF EXISTS public.consolidation_tolerance_cap();

ALTER TABLE public.consolidation_elimination_rules
  ADD COLUMN IF NOT EXISTS tolerance_percent numeric;

-- ---------------------------------------------------------------------------
-- Per-counterparty-pair overrides on top of the class default.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.consolidation_elimination_rule_pairs (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id uuid NOT NULL,
  group_id uuid NOT NULL REFERENCES public.consolidation_groups(id) ON DELETE CASCADE,
  elimination_class public.consolidation_elimination_class NOT NULL,
  business_a_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  business_b_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  tolerance_amount numeric NOT NULL DEFAULT 0,
  tolerance_percent numeric,
  tolerance_reason text,
  difference_policy public.consolidation_elimination_difference_policy,
  difference_group_account_id uuid REFERENCES public.consolidation_group_accounts(id),
  tolerance_set_by uuid,
  tolerance_set_at timestamp with time zone,
  created_by uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT consolidation_pair_rule_ordered CHECK (business_a_id < business_b_id),
  CONSTRAINT consolidation_pair_rule_unique UNIQUE (group_id, elimination_class, business_a_id, business_b_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.consolidation_elimination_rule_pairs TO authenticated;
GRANT ALL ON public.consolidation_elimination_rule_pairs TO service_role;

ALTER TABLE public.consolidation_elimination_rule_pairs ENABLE ROW LEVEL SECURITY;

CREATE POLICY consolidation_elimination_rule_pairs_select
  ON public.consolidation_elimination_rule_pairs FOR SELECT TO authenticated
  USING (
    public.is_org_member(auth.uid(), organization_id)
    AND EXISTS (SELECT 1 FROM public.consolidation_groups g
                 WHERE g.id = consolidation_elimination_rule_pairs.group_id
                   AND public.user_can_access_business(auth.uid(), g.parent_business_id))
  );

CREATE POLICY consolidation_elimination_rule_pairs_write
  ON public.consolidation_elimination_rule_pairs FOR ALL TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.consolidation_groups g
             WHERE g.id = consolidation_elimination_rule_pairs.group_id
               AND public.user_can_access_business(auth.uid(), g.parent_business_id))
    AND (public.has_org_role(auth.uid(), organization_id, 'owner'::public.app_role)
      OR public.has_org_role(auth.uid(), organization_id, 'admin'::public.app_role)
      OR public.has_org_role(auth.uid(), organization_id, 'super_admin'::public.app_role))
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.consolidation_groups g
             WHERE g.id = consolidation_elimination_rule_pairs.group_id
               AND public.user_can_access_business(auth.uid(), g.parent_business_id))
    AND (public.has_org_role(auth.uid(), organization_id, 'owner'::public.app_role)
      OR public.has_org_role(auth.uid(), organization_id, 'admin'::public.app_role)
      OR public.has_org_role(auth.uid(), organization_id, 'super_admin'::public.app_role))
  );

-- ---------------------------------------------------------------------------
-- Shared validation for both the class rule and a pair override.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._consolidation_validate_tolerance(
  _presentation_currency text,
  _tolerance_amount numeric,
  _tolerance_percent numeric,
  _tolerance_reason text,
  _difference_policy text,
  _difference_group_account_id uuid)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'public'
AS $$
DECLARE
  v_bound numeric;
BEGIN
  IF COALESCE(_tolerance_amount, 0) < 0 THEN
    RAISE EXCEPTION 'An elimination tolerance cannot be negative';
  END IF;

  IF _tolerance_percent IS NOT NULL AND (_tolerance_percent < 0 OR _tolerance_percent > 100) THEN
    RAISE EXCEPTION 'A percentage tolerance has to be between 0 and 100 per cent of the position it is measured against'
      USING ERRCODE = '22023';
  END IF;

  IF (COALESCE(_tolerance_amount, 0) > 0 OR COALESCE(_tolerance_percent, 0) > 0)
     AND (_tolerance_reason IS NULL OR length(btrim(_tolerance_reason)) < 20) THEN
    RAISE EXCEPTION 'A tolerance above zero has to say why this group accepts a difference of that size without treating it as a disagreement'
      USING ERRCODE = '22023';
  END IF;

  v_bound := public.consolidation_tolerance_rounding_bound(_presentation_currency);

  -- Beyond the rounding bound a tolerance is no longer absorbing rounding: it
  -- is a materiality judgement. It is allowed, but only where the group has
  -- also said where a difference of that size is carried and who decided it.
  IF COALESCE(_tolerance_amount, 0) > v_bound OR COALESCE(_tolerance_percent, 0) > 0 THEN
    IF COALESCE(_difference_policy, 'refuse') = 'refuse' THEN
      RAISE EXCEPTION 'A tolerance beyond the rounding bound of % % is a materiality judgement, not rounding. Say where a difference of that size goes before accepting one: a class set to refuse cannot also accept gaps of this size',
        v_bound, COALESCE(_presentation_currency, 'the presentation currency')
        USING ERRCODE = '22023';
    END IF;
    IF _difference_policy = 'post_difference' AND _difference_group_account_id IS NULL THEN
      RAISE EXCEPTION 'A tolerance beyond the rounding bound has to name the group account that carries the difference'
        USING ERRCODE = '22023';
    END IF;
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- The class rule guard, rebuilt on the governed bound.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._consolidation_elimination_rule_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_group public.consolidation_groups;
  v_changed boolean;
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

  -- A trading class may name the reserve, but only the part of a gap the
  -- engine can prove is a translation basis effect ever reaches it: the
  -- arithmetic split in consolidation_pair_residual decides, not this setting.
  IF NEW.difference_policy = 'post_to_cta' AND v_group.cta_account_id IS NULL THEN
    RAISE EXCEPTION 'This group has no translation reserve account configured, so a difference cannot be carried to one'
      USING ERRCODE = '22023';
  END IF;

  PERFORM public._consolidation_validate_tolerance(
    v_group.presentation_currency, NEW.tolerance_amount, NEW.tolerance_percent,
    NEW.tolerance_reason, NEW.difference_policy::text, NEW.difference_group_account_id);

  v_changed := TG_OP = 'INSERT'
            OR NEW.tolerance_amount IS DISTINCT FROM OLD.tolerance_amount
            OR NEW.tolerance_percent IS DISTINCT FROM OLD.tolerance_percent
            OR NEW.difference_policy IS DISTINCT FROM OLD.difference_policy
            OR NEW.difference_group_account_id IS DISTINCT FROM OLD.difference_group_account_id;

  IF v_changed THEN
    NEW.tolerance_set_by := COALESCE(auth.uid(), NEW.tolerance_set_by);
    NEW.tolerance_set_at := now();

    INSERT INTO public.consolidation_group_change_log (
      organization_id, group_id, entity, action, actor_id, before_state, after_state)
    VALUES (
      v_group.organization_id, NEW.group_id, 'elimination_rule', lower(TG_OP), auth.uid(),
      CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE jsonb_build_object(
        'elimination_class', OLD.elimination_class,
        'tolerance_amount', OLD.tolerance_amount,
        'tolerance_percent', OLD.tolerance_percent,
        'difference_policy', OLD.difference_policy,
        'difference_group_account_id', OLD.difference_group_account_id,
        'tolerance_reason', OLD.tolerance_reason) END,
      jsonb_build_object(
        'elimination_class', NEW.elimination_class,
        'tolerance_amount', NEW.tolerance_amount,
        'tolerance_percent', NEW.tolerance_percent,
        'difference_policy', NEW.difference_policy,
        'difference_group_account_id', NEW.difference_group_account_id,
        'tolerance_reason', NEW.tolerance_reason));
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$function$;

-- ---------------------------------------------------------------------------
-- The pair override guard.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._consolidation_elimination_pair_rule_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_group public.consolidation_groups;
BEGIN
  SELECT * INTO v_group FROM public.consolidation_groups g WHERE g.id = NEW.group_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Consolidation group not found';
  END IF;

  NEW.organization_id := v_group.organization_id;

  IF NOT EXISTS (SELECT 1 FROM public.consolidation_group_members m
                  WHERE m.group_id = NEW.group_id AND m.business_id = NEW.business_a_id)
     OR NOT EXISTS (SELECT 1 FROM public.consolidation_group_members m
                     WHERE m.group_id = NEW.group_id AND m.business_id = NEW.business_b_id) THEN
    RAISE EXCEPTION 'A pair tolerance can only be set between two companies that are members of this group'
      USING ERRCODE = '22023';
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

  IF NEW.difference_policy = 'post_difference' AND NEW.difference_group_account_id IS NULL THEN
    RAISE EXCEPTION 'A pair override that posts the difference must name the group account that carries it';
  END IF;

  PERFORM public._consolidation_validate_tolerance(
    v_group.presentation_currency, NEW.tolerance_amount, NEW.tolerance_percent,
    NEW.tolerance_reason,
    COALESCE(NEW.difference_policy::text,
             (SELECT r.difference_policy::text FROM public.consolidation_elimination_rules r
               WHERE r.group_id = NEW.group_id AND r.elimination_class = NEW.elimination_class),
             'refuse'),
    COALESCE(NEW.difference_group_account_id,
             (SELECT r.difference_group_account_id FROM public.consolidation_elimination_rules r
               WHERE r.group_id = NEW.group_id AND r.elimination_class = NEW.elimination_class)));

  NEW.tolerance_set_by := COALESCE(auth.uid(), NEW.tolerance_set_by);
  NEW.tolerance_set_at := now();
  NEW.updated_at := now();

  INSERT INTO public.consolidation_group_change_log (
    organization_id, group_id, entity, action, actor_id, before_state, after_state)
  VALUES (
    v_group.organization_id, NEW.group_id, 'elimination_rule_pair', lower(TG_OP), auth.uid(),
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END,
    to_jsonb(NEW));

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS _consolidation_elimination_pair_rule_guard ON public.consolidation_elimination_rule_pairs;
CREATE TRIGGER _consolidation_elimination_pair_rule_guard
  BEFORE INSERT OR UPDATE ON public.consolidation_elimination_rule_pairs
  FOR EACH ROW EXECUTE FUNCTION public._consolidation_elimination_pair_rule_guard();

-- ---------------------------------------------------------------------------
-- The tolerance actually in force for one pair and class.
-- Where an amount and a percentage are both set, the smaller governs.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.consolidation_effective_tolerance(
  _group_id uuid,
  _class public.consolidation_elimination_class,
  _business_a uuid,
  _business_b uuid,
  _gross_position numeric)
RETURNS TABLE (
  tolerance numeric,
  tolerance_amount numeric,
  tolerance_percent numeric,
  tolerance_reason text,
  difference_policy text,
  difference_group_account_id uuid,
  is_pair_override boolean)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_rule public.consolidation_elimination_rules;
  v_pair public.consolidation_elimination_rule_pairs;
  v_amount numeric;
  v_percent numeric;
  v_from_percent numeric;
BEGIN
  SELECT * INTO v_rule
    FROM public.consolidation_elimination_rules r
   WHERE r.group_id = _group_id AND r.elimination_class = _class;

  SELECT * INTO v_pair
    FROM public.consolidation_elimination_rule_pairs p
   WHERE p.group_id = _group_id
     AND p.elimination_class = _class
     AND p.business_a_id = least(_business_a::text, _business_b::text)::uuid
     AND p.business_b_id = greatest(_business_a::text, _business_b::text)::uuid;

  IF v_pair.id IS NOT NULL THEN
    v_amount  := COALESCE(v_pair.tolerance_amount, 0);
    v_percent := v_pair.tolerance_percent;
  ELSE
    v_amount  := COALESCE(v_rule.tolerance_amount, 0);
    v_percent := v_rule.tolerance_percent;
  END IF;

  v_from_percent := CASE
    WHEN v_percent IS NULL OR _gross_position IS NULL THEN NULL
    ELSE round(abs(_gross_position) * v_percent / 100, 2)
  END;

  RETURN QUERY SELECT
    CASE
      WHEN v_from_percent IS NULL THEN v_amount
      WHEN v_amount = 0 THEN v_from_percent
      ELSE least(v_amount, v_from_percent)
    END,
    v_amount,
    v_percent,
    COALESCE(v_pair.tolerance_reason, v_rule.tolerance_reason),
    COALESCE(v_pair.difference_policy::text, v_rule.difference_policy::text, 'refuse'),
    COALESCE(v_pair.difference_group_account_id, v_rule.difference_group_account_id),
    v_pair.id IS NOT NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.consolidation_tolerance_rounding_bound(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.consolidation_effective_tolerance(uuid, public.consolidation_elimination_class, uuid, uuid, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.consolidation_tolerance_rounding_bound(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.consolidation_effective_tolerance(uuid, public.consolidation_elimination_class, uuid, uuid, numeric) TO authenticated, service_role;