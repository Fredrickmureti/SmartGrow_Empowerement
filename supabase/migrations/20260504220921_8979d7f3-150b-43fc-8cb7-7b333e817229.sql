ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS week_starts_on smallint NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS weekly_hours_target numeric(5,2) NOT NULL DEFAULT 40;

COMMENT ON COLUMN public.businesses.week_starts_on IS '0=Sun, 1=Mon, 6=Sat. Drives week-based UIs (Timesheets, Attendance).';
COMMENT ON COLUMN public.businesses.weekly_hours_target IS 'Weekly working-hours target used by Timesheets.';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='businesses_week_starts_on_chk') THEN
    ALTER TABLE public.businesses ADD CONSTRAINT businesses_week_starts_on_chk CHECK (week_starts_on IN (0,1,6));
  END IF;
END $$;