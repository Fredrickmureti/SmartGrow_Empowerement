-- Wave B3.3 — preserve device-reported occurrence time on biometric punches.
ALTER TABLE public.attendance_events
  ADD COLUMN IF NOT EXISTS event_time timestamptz;

CREATE INDEX IF NOT EXISTS attendance_events_org_event_time_idx
  ON public.attendance_events(organization_id, event_time)
  WHERE event_time IS NOT NULL;

COMMENT ON COLUMN public.attendance_events.event_time IS
  'Wave B3.3: device-reported event timestamp from the originating terminal. NULL for historical rows and for events that do not originate from a hardware push (use created_at as fallback). Readers MUST coalesce(event_time, created_at).';
