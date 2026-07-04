DROP VIEW IF EXISTS public.one_on_ones_visible;

ALTER TABLE public.one_on_ones DROP COLUMN IF EXISTS action_items;

CREATE VIEW public.one_on_ones_visible
WITH (security_invoker = true) AS
SELECT
  id,
  organization_id,
  business_id,
  manager_id,
  employee_id,
  scheduled_at,
  duration_minutes,
  status,
  recurrence,
  shared_summary,
  completed_at,
  cancelled_reason,
  created_by,
  created_at,
  updated_at,
  CASE
    WHEN manager_id = current_employee_id(organization_id) OR is_manager_of(auth.uid(), employee_id) THEN private_notes_manager
    ELSE NULL::text
  END AS private_notes_manager,
  CASE
    WHEN employee_id = current_employee_id(organization_id) THEN private_notes_employee
    ELSE NULL::text
  END AS private_notes_employee
FROM public.one_on_ones o;

GRANT SELECT ON public.one_on_ones_visible TO authenticated;