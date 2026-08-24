CREATE TABLE public.crm_lead_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  lead_id uuid NOT NULL REFERENCES public.crm_leads(id) ON DELETE CASCADE,
  event text NOT NULL,
  from_status public.crm_lead_status,
  to_status public.crm_lead_status,
  from_stage_id uuid REFERENCES public.crm_stages(id),
  to_stage_id uuid REFERENCES public.crm_stages(id),
  from_value numeric,
  to_value numeric,
  from_assignee uuid,
  to_assignee uuid,
  reason text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_user_id uuid,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX crm_lead_history_lead_idx ON public.crm_lead_history (lead_id, occurred_at DESC);
CREATE INDEX crm_lead_history_business_idx ON public.crm_lead_history (business_id, occurred_at DESC);

GRANT SELECT ON public.crm_lead_history TO authenticated;
GRANT ALL ON public.crm_lead_history TO service_role;

ALTER TABLE public.crm_lead_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members read lead history of their business"
  ON public.crm_lead_history FOR SELECT TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id));

-- Append-only: the recorder is SECURITY DEFINER, so no role needs INSERT and
-- no role may ever mutate a recorded entry.
CREATE OR REPLACE FUNCTION public._crm_lead_history_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  RAISE EXCEPTION 'CRM: lead history is append-only' USING ERRCODE = '42501';
END;
$$;

CREATE TRIGGER trg_crm_lead_history_immutable
  BEFORE UPDATE OR DELETE ON public.crm_lead_history
  FOR EACH ROW EXECUTE FUNCTION public._crm_lead_history_immutable();