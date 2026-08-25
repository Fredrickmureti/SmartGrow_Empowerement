CREATE OR REPLACE FUNCTION public.project_closure_blockers(_project_id uuid)
RETURNS text[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_blockers text[] := '{}';
  v_n integer;
BEGIN
  SELECT count(*) INTO v_n
  FROM public.project_tasks t
  WHERE t.project_id = _project_id AND t.is_active AND NOT t.is_done;
  IF v_n > 0 THEN
    v_blockers := v_blockers || format('%s open task(s) must be completed or cancelled', v_n);
  END IF;

  SELECT count(*) INTO v_n
  FROM public.timesheets ts
  WHERE ts.project_id = _project_id
    AND COALESCE(ts.status, 'draft') NOT IN ('approved','rejected');
  IF v_n > 0 THEN
    v_blockers := v_blockers || format('%s time entr(y/ies) still awaiting approval', v_n);
  END IF;

  SELECT count(*) INTO v_n
  FROM public.project_milestones m
  JOIN public.projects p ON p.id = m.project_id
  WHERE m.project_id = _project_id
    AND m.is_reached
    AND p.is_billable
    AND COALESCE(m.billing_amount, 0) <> 0
    AND NOT COALESCE(m.is_invoiced, false)
    AND m.invoice_id IS NULL;
  IF v_n > 0 THEN
    v_blockers := v_blockers || format('%s reached milestone(s) not yet invoiced', v_n);
  END IF;

  RETURN v_blockers;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.project_closure_blockers(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.project_closure_blockers(uuid) TO authenticated;