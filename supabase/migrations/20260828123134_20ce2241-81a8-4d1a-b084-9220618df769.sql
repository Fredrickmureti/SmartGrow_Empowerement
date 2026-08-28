CREATE TABLE public.consolidation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  group_id uuid NOT NULL REFERENCES public.consolidation_groups(id) ON DELETE CASCADE,
  period_start date NOT NULL,
  period_end date NOT NULL,
  presentation_currency text NOT NULL,
  state text NOT NULL DEFAULT 'draft',
  eliminations_debit numeric NOT NULL DEFAULT 0,
  eliminations_credit numeric NOT NULL DEFAULT 0,
  balance_difference numeric NOT NULL DEFAULT 0,
  is_balanced boolean NOT NULL DEFAULT false,
  line_count integer NOT NULL DEFAULT 0,
  member_count integer NOT NULL DEFAULT 0,
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finalized_by uuid,
  finalized_at timestamptz,
  superseded_at timestamptz,
  superseded_by_run_id uuid REFERENCES public.consolidation_runs(id) ON DELETE SET NULL,
  CONSTRAINT consolidation_runs_state_check CHECK (state IN ('draft','final','superseded')),
  CONSTRAINT consolidation_runs_period_check CHECK (period_end >= period_start)
);

COMMENT ON TABLE public.consolidation_runs IS 'Brick 8: a persisted, versioned consolidation run. Stores what the consolidation engine reported for a group and period; it never recomputes accounting itself.';

CREATE INDEX consolidation_runs_group_period_idx ON public.consolidation_runs (group_id, period_start, period_end, created_at DESC);
CREATE UNIQUE INDEX consolidation_runs_one_final_idx ON public.consolidation_runs (group_id, period_start, period_end) WHERE state = 'final';

REVOKE ALL ON public.consolidation_runs FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.consolidation_runs TO authenticated;
GRANT ALL ON public.consolidation_runs TO service_role;

ALTER TABLE public.consolidation_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY consolidation_runs_select ON public.consolidation_runs
FOR SELECT USING (
  public.is_org_member(auth.uid(), organization_id)
  AND EXISTS (
    SELECT 1 FROM public.consolidation_groups g
     WHERE g.id = consolidation_runs.group_id
       AND public.user_can_access_business(auth.uid(), g.parent_business_id)
  )
);

CREATE POLICY consolidation_runs_write ON public.consolidation_runs
FOR ALL USING (
  EXISTS (
    SELECT 1 FROM public.consolidation_groups g
     WHERE g.id = consolidation_runs.group_id
       AND public.user_can_access_business(auth.uid(), g.parent_business_id)
  )
  AND (public.has_org_role(auth.uid(), organization_id, 'owner'::public.app_role)
    OR public.has_org_role(auth.uid(), organization_id, 'admin'::public.app_role)
    OR public.has_org_role(auth.uid(), organization_id, 'super_admin'::public.app_role))
) WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.consolidation_groups g
     WHERE g.id = consolidation_runs.group_id
       AND public.user_can_access_business(auth.uid(), g.parent_business_id)
  )
  AND (public.has_org_role(auth.uid(), organization_id, 'owner'::public.app_role)
    OR public.has_org_role(auth.uid(), organization_id, 'admin'::public.app_role)
    OR public.has_org_role(auth.uid(), organization_id, 'super_admin'::public.app_role))
);

CREATE OR REPLACE FUNCTION public._consolidation_run_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.group_id IS DISTINCT FROM OLD.group_id
       OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
       OR NEW.period_start IS DISTINCT FROM OLD.period_start
       OR NEW.period_end IS DISTINCT FROM OLD.period_end
       OR NEW.presentation_currency IS DISTINCT FROM OLD.presentation_currency
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'A consolidation run''s group, period and presentation currency are fixed at creation. Create a new run for a different basis; the existing run can then be superseded'
        USING ERRCODE = '42501';
    END IF;

    IF NEW.state IS DISTINCT FROM OLD.state THEN
      IF NOT ((OLD.state = 'draft' AND NEW.state IN ('final','superseded'))
           OR (OLD.state = 'final' AND NEW.state = 'superseded')) THEN
        RAISE EXCEPTION 'A consolidation run cannot move from % to %. A run goes draft to final, or is superseded by a later run', OLD.state, NEW.state
          USING ERRCODE = '42501';
      END IF;
    ELSIF OLD.state <> 'draft' THEN
      RAISE EXCEPTION 'This consolidation run is % and its figures are frozen. Create a new run for this group and period, which will supersede it', OLD.state
        USING ERRCODE = '42501';
    END IF;

    NEW.updated_at := now();
  END IF;

  IF TG_OP = 'DELETE' AND OLD.state <> 'draft' THEN
    RAISE EXCEPTION 'A % consolidation run is part of the reporting record and cannot be deleted. Supersede it with a new run instead', OLD.state
      USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER consolidation_runs_guard
BEFORE UPDATE OR DELETE ON public.consolidation_runs
FOR EACH ROW EXECUTE FUNCTION public._consolidation_run_guard();