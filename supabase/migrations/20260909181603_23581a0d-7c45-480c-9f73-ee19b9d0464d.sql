CREATE TABLE public.branch_day_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES public.branches(id) ON DELETE CASCADE,
  operational_day_id uuid NOT NULL REFERENCES public.branch_operational_days(id) ON DELETE CASCADE,
  business_date date NOT NULL,
  event_type text NOT NULL,
  actor_id uuid,
  opening_cash numeric(18,2),
  expected_cash numeric(18,2),
  counted_cash numeric(18,2),
  variance numeric(18,2),
  reason text,
  event_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT branch_day_events_type_chk CHECK (event_type IN ('opened','closed','reopened'))
);

CREATE INDEX idx_branch_day_events_day ON public.branch_day_events (operational_day_id, event_at DESC);

GRANT SELECT ON public.branch_day_events TO authenticated;
GRANT ALL ON public.branch_day_events TO service_role;

ALTER TABLE public.branch_day_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Business members can view branch day events"
ON public.branch_day_events FOR SELECT TO authenticated
USING (public.user_has_business_access(auth.uid(), business_id));

CREATE OR REPLACE FUNCTION public.branch_day_events_append_only()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'Branch day events are append-only';
END;
$$;

CREATE TRIGGER trg_branch_day_events_append_only
BEFORE UPDATE OR DELETE ON public.branch_day_events
FOR EACH ROW EXECUTE FUNCTION public.branch_day_events_append_only();