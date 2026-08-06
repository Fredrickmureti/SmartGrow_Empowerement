-- 1) Drop the dead duplicate GL engine (no application or database callers).
DROP FUNCTION IF EXISTS public.create_gl_entry_from_source(uuid, uuid, text, uuid, text, text, date, jsonb, boolean);
DROP FUNCTION IF EXISTS public.create_gl_entry_from_source(uuid, uuid, text, uuid, date, text, text, jsonb, boolean);

-- 2) Manual JE creation delegates to the single canonical posting engine.
CREATE OR REPLACE FUNCTION public.create_journal_entry_atomic(_org_id uuid, _business_id uuid, _entry_number text, _entry_date date, _description text, _reference text, _is_adjusting boolean, _is_closing boolean, _created_by uuid, _lines jsonb, _branch_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _entry_id uuid;
BEGIN
  -- Phase 7 gate: manual JE creation requires finance.manage_je at company scope.
  PERFORM public.assert_can_manage_je(_business_id);

  -- Single posting monopoly: all journal writes go through
  -- post_journal_entry_atomic (balancing, period locks, scope stamping).
  _entry_id := public.post_journal_entry_atomic(
    _org_id, _business_id, _entry_number, _entry_date,
    _reference, _description,
    'manual_journal_entry', NULL, _created_by,
    COALESCE(_is_closing, false), COALESCE(_is_adjusting, false),
    _lines,
    NULL, NULL, NULL, _branch_id
  );

  RETURN _entry_id;
END;
$function$;