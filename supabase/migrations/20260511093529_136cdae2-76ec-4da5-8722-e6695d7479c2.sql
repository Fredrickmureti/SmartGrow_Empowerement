
ALTER TABLE public.pos_registers
  ADD COLUMN IF NOT EXISTS auto_open_drawer_on_cash boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS auto_open_drawer_on_non_cash boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS require_reason_on_no_sale boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS confirm_before_drawer_open boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS public.pos_drawer_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  branch_id uuid,
  register_id uuid NOT NULL REFERENCES public.pos_registers(id) ON DELETE CASCADE,
  shift_id uuid,
  transaction_id uuid,
  reason text NOT NULL CHECK (reason IN ('auto_sale_kick','no_sale','cash_movement','manual_open','reprint','return','void')),
  reason_note text,
  triggered_by uuid,
  triggered_at timestamptz NOT NULL DEFAULT now(),
  hardware_success boolean,
  hardware_result jsonb
);

CREATE INDEX IF NOT EXISTS idx_pos_drawer_events_register_time
  ON public.pos_drawer_events (register_id, triggered_at DESC);
CREATE INDEX IF NOT EXISTS idx_pos_drawer_events_shift
  ON public.pos_drawer_events (shift_id);
CREATE INDEX IF NOT EXISTS idx_pos_drawer_events_business
  ON public.pos_drawer_events (business_id, triggered_at DESC);

ALTER TABLE public.pos_drawer_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Drawer events readable by business members"
  ON public.pos_drawer_events
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_business_access uba
      WHERE uba.business_id = pos_drawer_events.business_id
        AND uba.user_id = auth.uid()
    )
  );

CREATE POLICY "Drawer events insertable by business members"
  ON public.pos_drawer_events
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.user_business_access uba
      WHERE uba.business_id = pos_drawer_events.business_id
        AND uba.user_id = auth.uid()
    )
  );
