-- Fix "column reference is_active is ambiguous" in salary structure lifecycle RPCs
CREATE OR REPLACE FUNCTION public.archive_salary_structure(
  p_id uuid,
  p_reason text DEFAULT NULL
) RETURNS public.salary_structures
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  a RECORD;
  v_row public.salary_structures;
  v_from_state text;
BEGIN
  SELECT * INTO a FROM public._ss_authorize(p_id, 'write');
  v_from_state := CASE WHEN a.is_active THEN 'active' ELSE 'archived' END;

  UPDATE public.salary_structures
     SET is_active = false, archived_at = now(), updated_at = now()
   WHERE id = p_id
  RETURNING * INTO v_row;

  INSERT INTO public.salary_structure_lifecycle_events
    (organization_id, business_id, structure_id, structure_name_snapshot,
     event, from_state, to_state, reason, actor)
  VALUES
    (a.org_id, a.biz_id, p_id, v_row.name,
     'archived', v_from_state, 'archived', p_reason, auth.uid());

  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.restore_salary_structure(p_id uuid)
RETURNS public.salary_structures
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  a RECORD;
  v_row public.salary_structures;
BEGIN
  SELECT * INTO a FROM public._ss_authorize(p_id, 'write');

  UPDATE public.salary_structures
     SET is_active = true, archived_at = NULL, updated_at = now()
   WHERE id = p_id
  RETURNING * INTO v_row;

  INSERT INTO public.salary_structure_lifecycle_events
    (organization_id, business_id, structure_id, structure_name_snapshot,
     event, from_state, to_state, actor)
  VALUES
    (a.org_id, a.biz_id, p_id, v_row.name, 'restored', 'archived', 'active', auth.uid());

  RETURN v_row;
END;
$$;