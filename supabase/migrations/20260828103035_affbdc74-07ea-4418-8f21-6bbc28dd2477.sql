CREATE TABLE public.consolidation_elimination_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  group_id uuid NOT NULL REFERENCES public.consolidation_groups(id) ON DELETE CASCADE,
  period_start date NOT NULL,
  period_end date NOT NULL,
  action text NOT NULL CHECK (action IN ('generate', 'regenerate', 'reverse')),
  actor_id uuid,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  presentation_currency text,
  scope_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
  rule_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
  leg_count integer NOT NULL DEFAULT 0,
  difference_leg_count integer NOT NULL DEFAULT 0,
  total_debit numeric NOT NULL DEFAULT 0,
  total_credit numeric NOT NULL DEFAULT 0,
  replaced_leg_count integer NOT NULL DEFAULT 0,
  replaced_total_debit numeric NOT NULL DEFAULT 0,
  replaced_total_credit numeric NOT NULL DEFAULT 0,
  reason text
);

COMMENT ON TABLE public.consolidation_elimination_events IS
  'Append-only history of consolidation elimination generations and reversals. Written only by the elimination engine; never by hand. A refusal aborts its transaction and therefore cannot be recorded here - refusals are raised to the caller instead.';

CREATE INDEX consolidation_elimination_events_group_period_idx
  ON public.consolidation_elimination_events (group_id, period_start, period_end, occurred_at DESC);

GRANT SELECT, INSERT ON public.consolidation_elimination_events TO authenticated;
GRANT ALL ON public.consolidation_elimination_events TO service_role;

ALTER TABLE public.consolidation_elimination_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY consolidation_elimination_events_select
  ON public.consolidation_elimination_events
  FOR SELECT
  TO authenticated
  USING (
    public.is_org_member(auth.uid(), organization_id)
    AND EXISTS (
      SELECT 1 FROM public.consolidation_groups g
       WHERE g.id = consolidation_elimination_events.group_id
         AND public.user_can_access_business(auth.uid(), g.parent_business_id)
    )
    AND (public.has_org_role(auth.uid(), organization_id, 'owner'::public.app_role)
      OR public.has_org_role(auth.uid(), organization_id, 'admin'::public.app_role)
      OR public.has_org_role(auth.uid(), organization_id, 'super_admin'::public.app_role))
  );

CREATE POLICY consolidation_elimination_events_insert
  ON public.consolidation_elimination_events
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.consolidation_groups g
       WHERE g.id = consolidation_elimination_events.group_id
         AND public.user_can_access_business(auth.uid(), g.parent_business_id)
    )
    AND (public.has_org_role(auth.uid(), organization_id, 'owner'::public.app_role)
      OR public.has_org_role(auth.uid(), organization_id, 'admin'::public.app_role)
      OR public.has_org_role(auth.uid(), organization_id, 'super_admin'::public.app_role))
  );

CREATE TRIGGER consolidation_elimination_events_engine_only
  BEFORE INSERT OR UPDATE OR DELETE ON public.consolidation_elimination_events
  FOR EACH ROW EXECUTE FUNCTION public._consolidation_eliminations_engine_only();