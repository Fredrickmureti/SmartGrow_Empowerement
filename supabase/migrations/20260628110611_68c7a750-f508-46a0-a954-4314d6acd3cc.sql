
-- Phase B kickoff: Organization benchmark — departments lifecycle
DO $$ BEGIN
  CREATE TYPE public.department_status AS ENUM ('active','archived','dissolved');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE public.departments
  ADD COLUMN IF NOT EXISTS status public.department_status NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS archived_by uuid,
  ADD COLUMN IF NOT EXISTS dissolved_at timestamptz,
  ADD COLUMN IF NOT EXISTS dissolved_by uuid;

-- Backfill: any inactive department becomes 'archived'.
UPDATE public.departments
SET status = 'archived', archived_at = COALESCE(archived_at, updated_at, now())
WHERE is_active = false AND status = 'active';

CREATE INDEX IF NOT EXISTS departments_status_idx
  ON public.departments (organization_id, status);

-- Archive
CREATE OR REPLACE FUNCTION public.archive_department(_department_id uuid, _reason text DEFAULT NULL)
RETURNS public.departments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _row public.departments;
BEGIN
  SELECT * INTO _row FROM public.departments WHERE id = _department_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'department_not_found'; END IF;
  IF NOT (public.has_role(auth.uid(), _row.organization_id, 'admin'::app_role)
       OR public.has_role(auth.uid(), _row.organization_id, 'owner'::app_role)) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;
  UPDATE public.departments
    SET status='archived', is_active=false, archived_at=now(), archived_by=auth.uid(), updated_at=now()
    WHERE id=_department_id
    RETURNING * INTO _row;
  RETURN _row;
END $$;

-- Restore
CREATE OR REPLACE FUNCTION public.restore_department(_department_id uuid)
RETURNS public.departments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _row public.departments;
BEGIN
  SELECT * INTO _row FROM public.departments WHERE id = _department_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'department_not_found'; END IF;
  IF NOT (public.has_role(auth.uid(), _row.organization_id, 'admin'::app_role)
       OR public.has_role(auth.uid(), _row.organization_id, 'owner'::app_role)) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;
  IF _row.status = 'dissolved' THEN
    RAISE EXCEPTION 'cannot_restore_dissolved_department';
  END IF;
  UPDATE public.departments
    SET status='active', is_active=true, archived_at=NULL, archived_by=NULL, updated_at=now()
    WHERE id=_department_id
    RETURNING * INTO _row;
  RETURN _row;
END $$;

-- Dissolve (terminal)
CREATE OR REPLACE FUNCTION public.dissolve_department(_department_id uuid)
RETURNS public.departments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _row public.departments;
  _active_emp int;
BEGIN
  SELECT * INTO _row FROM public.departments WHERE id = _department_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'department_not_found'; END IF;
  IF NOT (public.has_role(auth.uid(), _row.organization_id, 'owner'::app_role)) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;
  SELECT count(*) INTO _active_emp
    FROM public.employees
    WHERE department_id = _department_id AND is_active = true;
  IF _active_emp > 0 THEN
    RAISE EXCEPTION 'department_has_active_employees';
  END IF;
  UPDATE public.departments
    SET status='dissolved', is_active=false, dissolved_at=now(), dissolved_by=auth.uid(), updated_at=now()
    WHERE id=_department_id
    RETURNING * INTO _row;
  RETURN _row;
END $$;

GRANT EXECUTE ON FUNCTION public.archive_department(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.restore_department(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.dissolve_department(uuid) TO authenticated;
