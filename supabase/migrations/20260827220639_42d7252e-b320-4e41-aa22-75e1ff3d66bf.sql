-- Step 7.3 — Default elimination rule templates.
--
-- A group with no rules fell back to tolerance 0 / refuse, so the first run of
-- every new group failed on the first rounding cent. Mature systems ship
-- pre-built elimination templates; this project already does that for the chart
-- of accounts. Defaults are seeded at group creation, backfilled for existing
-- groups, marked as system defaults, and fully overridable.

ALTER TABLE public.consolidation_elimination_rules
  ADD COLUMN IF NOT EXISTS is_system_default boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS seeded_at timestamptz;

COMMENT ON COLUMN public.consolidation_elimination_rules.is_system_default IS
'True while the row still holds the seeded default policy. Any user edit flips it to false so settings can show default versus override.';

-- Marks a row as customised the moment a person edits it. The seeder sets
-- app.consolidation_rule_seeding for its own inserts.
CREATE OR REPLACE FUNCTION public._consolidation_elimination_rule_default_flag()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public'
AS $function$
DECLARE v_seeding boolean := COALESCE(current_setting('app.consolidation_rule_seeding', true), '') = 'on';
BEGIN
  IF v_seeding THEN
    NEW.is_system_default := true;
    NEW.seeded_at := COALESCE(NEW.seeded_at, now());
  ELSE
    NEW.is_system_default := false;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_consolidation_elimination_rule_default_flag
  ON public.consolidation_elimination_rules;
CREATE TRIGGER trg_consolidation_elimination_rule_default_flag
  BEFORE INSERT OR UPDATE ON public.consolidation_elimination_rules
  FOR EACH ROW EXECUTE FUNCTION public._consolidation_elimination_rule_default_flag();

-- The seeded template, in one place so the trigger, the backfill and the
-- explicit helper cannot drift apart.
--   tolerance: one unit of the presentation currency — rounding scale, not a
--              materiality threshold sized to swallow a translation residual;
--   policy:    post_to_cta — a cross-currency residual belongs in the
--              translation reserve (IAS 21 / ASC 830); a same-currency gap is
--              refused by the engine with its own explanation, because that is
--              a disagreement, not a translation effect.
CREATE OR REPLACE FUNCTION public._consolidation_seed_default_rules(_group_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_group public.consolidation_groups;
  v_inserted integer := 0;
BEGIN
  SELECT * INTO v_group FROM public.consolidation_groups g WHERE g.id = _group_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Consolidation group not found';
  END IF;

  PERFORM set_config('app.consolidation_rule_seeding', 'on', true);

  INSERT INTO public.consolidation_elimination_rules (
    organization_id, group_id, elimination_class, is_active,
    tolerance_amount, difference_policy, notes, created_by, seeded_at)
  SELECT v_group.organization_id, _group_id, c.cls, true,
         1.00, 'post_to_cta'::public.consolidation_elimination_difference_policy,
         'Seeded default: rounding-scale tolerance, currency-translation residual carried to the group translation reserve.',
         auth.uid(), now()
    FROM (VALUES ('intercompany_balance'::public.consolidation_elimination_class),
                 ('intercompany_trading'::public.consolidation_elimination_class)) AS c(cls)
   WHERE NOT EXISTS (
     SELECT 1 FROM public.consolidation_elimination_rules r
      WHERE r.group_id = _group_id AND r.elimination_class = c.cls);

  v_inserted := ROW_COUNT_HACK();
  RETURN v_inserted;
EXCEPTION WHEN undefined_function THEN
  RETURN NULL;
END;
$function$;

-- Replace the placeholder above with the real row count (kept separate so the
-- template text stays readable).
CREATE OR REPLACE FUNCTION public._consolidation_seed_default_rules(_group_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_group public.consolidation_groups;
  v_inserted integer := 0;
BEGIN
  SELECT * INTO v_group FROM public.consolidation_groups g WHERE g.id = _group_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Consolidation group not found';
  END IF;

  PERFORM set_config('app.consolidation_rule_seeding', 'on', true);

  INSERT INTO public.consolidation_elimination_rules (
    organization_id, group_id, elimination_class, is_active,
    tolerance_amount, difference_policy, notes, created_by, seeded_at)
  SELECT v_group.organization_id, _group_id, c.cls, true,
         1.00, 'post_to_cta'::public.consolidation_elimination_difference_policy,
         'Seeded default: rounding-scale tolerance, currency-translation residual carried to the group translation reserve.',
         auth.uid(), now()
    FROM (VALUES ('intercompany_balance'::public.consolidation_elimination_class),
                 ('intercompany_trading'::public.consolidation_elimination_class)) AS c(cls)
   WHERE NOT EXISTS (
     SELECT 1 FROM public.consolidation_elimination_rules r
      WHERE r.group_id = _group_id AND r.elimination_class = c.cls);

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  PERFORM set_config('app.consolidation_rule_seeding', 'off', true);
  RETURN v_inserted;
END;
$function$;

REVOKE ALL ON FUNCTION public._consolidation_seed_default_rules(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._consolidation_seed_default_rules(uuid) TO service_role;

-- A new group is never left without a policy.
CREATE OR REPLACE FUNCTION public._consolidation_group_seed_rules()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public._consolidation_seed_default_rules(NEW.id);
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_consolidation_group_seed_rules ON public.consolidation_groups;
CREATE TRIGGER trg_consolidation_group_seed_rules
  AFTER INSERT ON public.consolidation_groups
  FOR EACH ROW EXECUTE FUNCTION public._consolidation_group_seed_rules();

-- Caller-facing (re)seed of missing classes, for groups created before this
-- change and for a class someone deleted. Never overwrites an existing policy.
CREATE OR REPLACE FUNCTION public.consolidation_seed_default_elimination_rules(_group_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public'
AS $function$
DECLARE v_group public.consolidation_groups;
BEGIN
  SELECT * INTO v_group FROM public.consolidation_groups g WHERE g.id = _group_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Consolidation group not found or not visible to you' USING ERRCODE = '42501';
  END IF;

  IF NOT (public.has_org_role(auth.uid(), v_group.organization_id, 'owner'::public.app_role)
       OR public.has_org_role(auth.uid(), v_group.organization_id, 'admin'::public.app_role)
       OR public.has_org_role(auth.uid(), v_group.organization_id, 'super_admin'::public.app_role)) THEN
    RAISE EXCEPTION 'You are not allowed to change this group''s elimination policy' USING ERRCODE = '42501';
  END IF;

  RETURN public._consolidation_seed_default_rules(_group_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.consolidation_seed_default_elimination_rules(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.consolidation_seed_default_elimination_rules(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.consolidation_seed_default_elimination_rules(uuid) TO service_role;

COMMENT ON FUNCTION public.consolidation_seed_default_elimination_rules(uuid) IS
'Adds the seeded default elimination policy for any class a group is missing. Existing policies are left untouched. Owner/admin/super-admin of the group organisation only.';

-- Backfill every existing group's missing classes.
DO $$
DECLARE g record;
BEGIN
  FOR g IN SELECT id FROM public.consolidation_groups LOOP
    PERFORM public._consolidation_seed_default_rules(g.id);
  END LOOP;
END $$;
