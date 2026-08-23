CREATE OR REPLACE FUNCTION public.set_budget_status(_budget_id uuid, _status budget_status)
 RETURNS budgets
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  b public.budgets;
BEGIN
  b := public._budget_assert_manage(_budget_id);

  IF _status NOT IN ('active', 'closed') THEN
    RAISE EXCEPTION 'A budget can only be activated or closed' USING ERRCODE = '23514';
  END IF;

  IF _status = 'active' AND NOT EXISTS (
    SELECT 1 FROM public.budget_items WHERE budget_id = _budget_id
  ) THEN
    RAISE EXCEPTION 'A budget must have at least one line before it can be activated'
      USING ERRCODE = '23514';
  END IF;

  -- Putting a budget in force IS the approval act. Stamp it once: a budget
  -- closed later is still the instrument approved on the original date.
  UPDATE public.budgets
  SET status = _status,
      approved_by = CASE
        WHEN _status = 'active' AND approved_at IS NULL THEN auth.uid()
        ELSE approved_by
      END,
      approved_at = CASE
        WHEN _status = 'active' AND approved_at IS NULL THEN now()
        ELSE approved_at
      END
  WHERE id = _budget_id
  RETURNING * INTO b;

  RETURN b;
END;
$function$;