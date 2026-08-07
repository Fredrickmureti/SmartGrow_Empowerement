-- Phase 4: preview gains warehouse + bank sections ---------------------
CREATE OR REPLACE FUNCTION public.preview_reversal_consequences(_document_type text, _document_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_base       jsonb;
  v_warnings   jsonb;
  v_tasks      jsonb := '[]'::jsonb;
  v_bank       jsonb := '[]'::jsonb;
  v_in_progress int := 0;
BEGIN
  v_base := public.preview_reversal_consequences_core(_document_type, _document_id);
  v_warnings := COALESCE(v_base->'warnings', '[]'::jsonb);

  -- Warehouse tasks that the reversal would cancel.
  v_tasks := public.wms_open_tasks_for_document(_document_type, _document_id);

  SELECT count(*) INTO v_in_progress
    FROM jsonb_array_elements(v_tasks) t
   WHERE t->>'state' IN ('in_progress','claimed','paused','resumed');

  IF jsonb_array_length(v_tasks) > 0 THEN
    v_warnings := v_warnings || jsonb_build_object(
      'code', 'warehouse_tasks_cancelled',
      'severity', CASE WHEN v_in_progress > 0 THEN 'warning' ELSE 'info' END,
      'message', jsonb_array_length(v_tasks) || ' open warehouse task(s) belong to this document and would be cancelled'
                 || CASE WHEN v_in_progress > 0
                         THEN ', including ' || v_in_progress || ' already being worked on the floor.'
                         ELSE '.' END);
  END IF;

  -- Bank statement lines that must be un-matched before the reversal.
  v_bank := public.reversal_bank_lines(_document_type, _document_id);

  IF jsonb_array_length(v_bank) > 0 THEN
    v_warnings := v_warnings || jsonb_build_object(
      'code', 'bank_lines_matched',
      'severity', 'error',
      'message', jsonb_array_length(v_bank) || ' reconciled bank statement line(s) are matched to this document''s payment(s). Un-match them first, or the bank reconciliation and the ledger will disagree.');
  END IF;

  RETURN v_base
    || jsonb_build_object(
         'warehouse', jsonb_build_object(
                        'tasks', v_tasks,
                        'task_count', jsonb_array_length(v_tasks),
                        'in_progress_count', v_in_progress),
         'bank', jsonb_build_object(
                   'lines', v_bank,
                   'line_count', jsonb_array_length(v_bank)),
         'warnings', v_warnings);
END;
$function$;

REVOKE ALL ON FUNCTION public.preview_reversal_consequences(text, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.preview_reversal_consequences(text, uuid) TO authenticated;
