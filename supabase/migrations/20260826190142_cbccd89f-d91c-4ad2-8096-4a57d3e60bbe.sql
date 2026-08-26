CREATE OR REPLACE FUNCTION public.close_consolidation_member(
  _id uuid,
  _effective_to date DEFAULT CURRENT_DATE
)
RETURNS public.consolidation_group_members
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_row public.consolidation_group_members;
BEGIN
  IF _effective_to IS NULL THEN
    RAISE EXCEPTION 'An end date is required to close a membership' USING ERRCODE = '22004';
  END IF;

  -- RLS decides visibility and write permission; a caller without the group write
  -- role simply sees no row.
  SELECT * INTO v_row FROM public.consolidation_group_members WHERE id = _id;
  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'Consolidation membership not found or not accessible' USING ERRCODE = '42501';
  END IF;

  IF v_row.effective_to IS NOT NULL THEN
    RAISE EXCEPTION 'Membership was already closed on %', v_row.effective_to USING ERRCODE = '23514';
  END IF;

  IF _effective_to <= v_row.effective_from THEN
    RAISE EXCEPTION 'End date must be after the start date %', v_row.effective_from
      USING ERRCODE = '23514';
  END IF;

  UPDATE public.consolidation_group_members
     SET effective_to = _effective_to
   WHERE id = _id
   RETURNING * INTO v_row;

  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'Not permitted to change this consolidation membership' USING ERRCODE = '42501';
  END IF;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.close_consolidation_member(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.close_consolidation_member(uuid, date) TO authenticated;