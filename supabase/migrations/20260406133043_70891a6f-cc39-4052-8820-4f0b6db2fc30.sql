-- Core field overrides: let orgs hide/reorder/relabel built-in fields
CREATE TABLE IF NOT EXISTS public.core_field_overrides (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  field_key TEXT NOT NULL,
  is_visible BOOLEAN NOT NULL DEFAULT true,
  display_order INTEGER DEFAULT 0,
  label_override TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(organization_id, entity_type, field_key)
);

ALTER TABLE public.core_field_overrides ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their org core field overrides"
  ON public.core_field_overrides FOR SELECT
  TO authenticated
  USING (organization_id IN (
    SELECT organization_id FROM public.profiles WHERE id = auth.uid()
  ));

CREATE POLICY "Users can manage their org core field overrides"
  ON public.core_field_overrides FOR ALL
  TO authenticated
  USING (organization_id IN (
    SELECT organization_id FROM public.profiles WHERE id = auth.uid()
  ))
  WITH CHECK (organization_id IN (
    SELECT organization_id FROM public.profiles WHERE id = auth.uid()
  ));

CREATE INDEX idx_core_field_overrides_org_entity 
  ON public.core_field_overrides(organization_id, entity_type);

-- Automation circuit breaker: track execution counts per hour
CREATE TABLE IF NOT EXISTS public.automation_execution_tracker (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  automation_id UUID NOT NULL REFERENCES public.automated_actions(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  hour_bucket TIMESTAMPTZ NOT NULL DEFAULT date_trunc('hour', now()),
  execution_count INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(automation_id, hour_bucket)
);

ALTER TABLE public.automation_execution_tracker ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their org automation execution tracker"
  ON public.automation_execution_tracker FOR SELECT
  TO authenticated
  USING (organization_id IN (
    SELECT organization_id FROM public.profiles WHERE id = auth.uid()
  ));

CREATE INDEX idx_automation_exec_tracker_lookup 
  ON public.automation_execution_tracker(automation_id, hour_bucket);

-- Add circuit breaker flag to automated_actions
ALTER TABLE public.automated_actions 
  ADD COLUMN IF NOT EXISTS is_circuit_broken BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS circuit_broken_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS circuit_broken_reason TEXT;

-- Function to increment execution count and check circuit breaker
CREATE OR REPLACE FUNCTION public.check_automation_circuit_breaker(
  _automation_id UUID,
  _organization_id UUID,
  _max_executions_per_hour INTEGER DEFAULT 50
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _current_count INTEGER;
  _hour TIMESTAMPTZ := date_trunc('hour', now());
BEGIN
  -- Upsert execution count
  INSERT INTO automation_execution_tracker (automation_id, organization_id, hour_bucket, execution_count)
  VALUES (_automation_id, _organization_id, _hour, 1)
  ON CONFLICT (automation_id, hour_bucket)
  DO UPDATE SET execution_count = automation_execution_tracker.execution_count + 1
  RETURNING execution_count INTO _current_count;

  -- If over limit, circuit-break the automation
  IF _current_count > _max_executions_per_hour THEN
    UPDATE automated_actions 
    SET is_active = false, 
        is_circuit_broken = true, 
        circuit_broken_at = now(),
        circuit_broken_reason = format('Exceeded %s executions in 1 hour (count: %s)', _max_executions_per_hour, _current_count)
    WHERE id = _automation_id;
    RETURN false;
  END IF;

  RETURN true;
END;
$$;

-- Cleanup old tracker rows (keep last 48 hours)
CREATE OR REPLACE FUNCTION public.cleanup_automation_tracker()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM automation_execution_tracker 
  WHERE hour_bucket < now() - interval '48 hours';
$$;