ALTER TABLE public.business_event_outbox
  ADD COLUMN IF NOT EXISTS handler_scope text NOT NULL DEFAULT 'host';

CREATE INDEX IF NOT EXISTS idx_business_event_outbox_scope_status
  ON public.business_event_outbox (handler_scope, status, created_at)
  WHERE status IN ('pending','running');