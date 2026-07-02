-- Align projects.last_update_status CHECK with project_updates.status enum.
-- The status mirror trigger fails when an update with status='done' is posted
-- because the projects table CHECK does not allow 'done'.
DO $$
DECLARE
  c text;
BEGIN
  SELECT conname INTO c
  FROM pg_constraint
  WHERE conrelid = 'public.projects'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%last_update_status%';

  IF c IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.projects DROP CONSTRAINT %I', c);
  END IF;
END $$;

ALTER TABLE public.projects
  ADD CONSTRAINT projects_last_update_status_check
  CHECK (
    last_update_status IS NULL
    OR last_update_status IN ('on_track', 'at_risk', 'off_track', 'done')
  );