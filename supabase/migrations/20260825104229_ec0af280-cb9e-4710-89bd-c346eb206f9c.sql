ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;

CREATE OR REPLACE FUNCTION public._projects_bump_version()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    NEW.version := COALESCE(OLD.version, 0) + 1;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_projects_bump_version ON public.projects;
CREATE TRIGGER trg_projects_bump_version
  BEFORE UPDATE ON public.projects
  FOR EACH ROW EXECUTE FUNCTION public._projects_bump_version();