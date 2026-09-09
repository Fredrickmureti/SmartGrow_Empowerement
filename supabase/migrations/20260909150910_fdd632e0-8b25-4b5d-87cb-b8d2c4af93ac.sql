ALTER TABLE public.mf_group_meetings
  ADD COLUMN IF NOT EXISTS started_at_time time,
  ADD COLUMN IF NOT EXISTS ended_at_time time,
  ADD COLUMN IF NOT EXISTS held_by uuid,
  ADD COLUMN IF NOT EXISTS recorded_by uuid;

COMMENT ON COLUMN public.mf_group_meetings.started_at_time IS 'Actual clock time the meeting started, as reported by the field officer.';
COMMENT ON COLUMN public.mf_group_meetings.ended_at_time IS 'Actual clock time the meeting ended, as reported by the field officer.';
COMMENT ON COLUMN public.mf_group_meetings.held_by IS 'Officer who actually conducted the meeting (may differ from the person who entered it).';
COMMENT ON COLUMN public.mf_group_meetings.recorded_by IS 'User who entered the completed meeting record.';