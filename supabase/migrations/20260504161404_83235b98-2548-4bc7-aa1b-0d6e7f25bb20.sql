
-- ============================================================
-- Stage 1: Employees-app foundations — Job Positions & Work Locations
-- ============================================================

-- 1. job_positions ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.job_positions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  business_id UUID NOT NULL,
  name TEXT NOT NULL,
  code TEXT,
  department_id UUID REFERENCES public.departments(id) ON DELETE SET NULL,
  description TEXT,
  target_headcount INTEGER,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID,
  UNIQUE (organization_id, business_id, name)
);

CREATE INDEX IF NOT EXISTS idx_job_positions_org_biz
  ON public.job_positions (organization_id, business_id);
CREATE INDEX IF NOT EXISTS idx_job_positions_dept
  ON public.job_positions (department_id);

ALTER TABLE public.job_positions ENABLE ROW LEVEL SECURITY;

CREATE POLICY job_positions_select_perm ON public.job_positions
  FOR SELECT USING (user_has_module_permission(auth.uid(), organization_id, 'hr', 'read'));
CREATE POLICY job_positions_insert_perm ON public.job_positions
  FOR INSERT WITH CHECK (user_has_module_permission(auth.uid(), organization_id, 'hr', 'create'));
CREATE POLICY job_positions_update_perm ON public.job_positions
  FOR UPDATE USING (user_has_module_permission(auth.uid(), organization_id, 'hr', 'write'));
CREATE POLICY job_positions_delete_perm ON public.job_positions
  FOR DELETE USING (user_has_module_permission(auth.uid(), organization_id, 'hr', 'delete'));

CREATE TRIGGER update_job_positions_updated_at
  BEFORE UPDATE ON public.job_positions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 2. work_locations -----------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE public.work_location_type AS ENUM ('office', 'remote', 'other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.work_locations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  business_id UUID NOT NULL,
  name TEXT NOT NULL,
  location_type public.work_location_type NOT NULL DEFAULT 'office',
  address TEXT,
  branch_id UUID,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID,
  UNIQUE (organization_id, business_id, name)
);

CREATE INDEX IF NOT EXISTS idx_work_locations_org_biz
  ON public.work_locations (organization_id, business_id);

ALTER TABLE public.work_locations ENABLE ROW LEVEL SECURITY;

CREATE POLICY work_locations_select_perm ON public.work_locations
  FOR SELECT USING (user_has_module_permission(auth.uid(), organization_id, 'hr', 'read'));
CREATE POLICY work_locations_insert_perm ON public.work_locations
  FOR INSERT WITH CHECK (user_has_module_permission(auth.uid(), organization_id, 'hr', 'create'));
CREATE POLICY work_locations_update_perm ON public.work_locations
  FOR UPDATE USING (user_has_module_permission(auth.uid(), organization_id, 'hr', 'write'));
CREATE POLICY work_locations_delete_perm ON public.work_locations
  FOR DELETE USING (user_has_module_permission(auth.uid(), organization_id, 'hr', 'delete'));

CREATE TRIGGER update_work_locations_updated_at
  BEFORE UPDATE ON public.work_locations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 3. Link columns on employees -----------------------------------------------
ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS job_position_id UUID REFERENCES public.job_positions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS work_location_id UUID REFERENCES public.work_locations(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_employees_job_position ON public.employees (job_position_id);
CREATE INDEX IF NOT EXISTS idx_employees_work_location ON public.employees (work_location_id);

-- 4. Best-effort backfill ----------------------------------------------------
-- Create one job_position per distinct (org, business, position) combo
INSERT INTO public.job_positions (organization_id, business_id, name, is_active)
SELECT DISTINCT e.organization_id, e.business_id, btrim(e.position), true
FROM public.employees e
WHERE e.position IS NOT NULL
  AND btrim(e.position) <> ''
  AND e.business_id IS NOT NULL
ON CONFLICT (organization_id, business_id, name) DO NOTHING;

-- Link employees to their (newly-created) job_position
UPDATE public.employees e
SET job_position_id = jp.id
FROM public.job_positions jp
WHERE e.job_position_id IS NULL
  AND e.position IS NOT NULL
  AND btrim(e.position) <> ''
  AND jp.organization_id = e.organization_id
  AND jp.business_id = e.business_id
  AND jp.name = btrim(e.position);
