-- ============================================================
-- Phase 4 §2 · Typed exception triage + SLA due_by
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'wms_exception_resolution_kind') THEN
    CREATE TYPE public.wms_exception_resolution_kind AS ENUM (
      'short_scan',
      'damaged',
      'wrong_bin',
      'wrong_lp',
      'legacy_short_dispatch',
      'miscount',
      'process_error',
      'system_error',
      'other'
    );
  END IF;
END $$;

ALTER TABLE public.wms_exceptions
  ADD COLUMN IF NOT EXISTS resolution_kind public.wms_exception_resolution_kind,
  ADD COLUMN IF NOT EXISTS due_by timestamptz;

-- SLA per exception kind, in minutes. Used to default due_by at raise time.
CREATE OR REPLACE FUNCTION public._wms_exception_sla_minutes(p_kind public.wms_exception_kind, p_severity smallint)
RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $$
  SELECT GREATEST(
    15,
    (CASE p_kind
       WHEN 'qc_fail'                THEN 120
       WHEN 'receiving_discrepancy'  THEN 240
       WHEN 'short_pick'             THEN 60
       WHEN 'count_variance'         THEN 480
       WHEN 'damaged_lpn'            THEN 240
       WHEN 'unknown_scan'           THEN 60
       WHEN 'invalid_bin'            THEN 120
       WHEN 'capacity_exceeded'      THEN 120
       WHEN 'stale_task'             THEN 30
       ELSE 240
     END)
    / GREATEST(1, COALESCE(p_severity, 2))
  )::integer
$$;

CREATE OR REPLACE FUNCTION public._wms_exception_default_due_by()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.due_by IS NULL THEN
    NEW.due_by := COALESCE(NEW.created_at, now())
      + make_interval(mins => public._wms_exception_sla_minutes(NEW.kind, NEW.severity));
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS tg_wms_exception_default_due_by ON public.wms_exceptions;
CREATE TRIGGER tg_wms_exception_default_due_by
  BEFORE INSERT ON public.wms_exceptions
  FOR EACH ROW EXECUTE FUNCTION public._wms_exception_default_due_by();

-- Backfill existing rows so the SLA board is meaningful from day one.
UPDATE public.wms_exceptions
   SET due_by = created_at + make_interval(mins => public._wms_exception_sla_minutes(kind, severity))
 WHERE due_by IS NULL;

-- Terminal transitions now require a typed resolution kind + notes.
CREATE OR REPLACE FUNCTION public.wms_resolve_exception(
  p_exception_id uuid,
  p_to_state wms_exception_state,
  p_row_version integer,
  p_resolution text DEFAULT NULL::text,
  p_resolution_kind public.wms_exception_resolution_kind DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_row public.wms_exceptions%ROWTYPE;
  v_from wms_exception_state;
  v_allowed boolean := false;
  v_new_rv integer;
  v_terminal boolean;
BEGIN
  SELECT * INTO v_row FROM public.wms_exceptions WHERE id = p_exception_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Exception not found' USING ERRCODE='P0002'; END IF;
  IF v_row.row_version <> p_row_version THEN
    RAISE EXCEPTION 'Row version mismatch (have %, expected %)', v_row.row_version, p_row_version USING ERRCODE = '40001';
  END IF;
  v_from := v_row.state;
  v_terminal := p_to_state IN ('resolved','wont_fix');

  v_allowed := CASE
    WHEN v_from = 'open'          AND p_to_state IN ('acknowledged','investigating','escalated','resolved','wont_fix') THEN true
    WHEN v_from = 'acknowledged'  AND p_to_state IN ('investigating','escalated','resolved','wont_fix')                THEN true
    WHEN v_from = 'investigating' AND p_to_state IN ('escalated','resolved','wont_fix')                                 THEN true
    WHEN v_from = 'escalated'     AND p_to_state IN ('investigating','resolved','wont_fix')                             THEN true
    ELSE false
  END;
  IF NOT v_allowed THEN
    RAISE EXCEPTION 'Illegal exception transition % → %', v_from, p_to_state USING ERRCODE='22023';
  END IF;

  -- Phase 4 §2: closing an exception without a category is how root-cause
  -- data rots. Require both the kind and free-text notes on terminal moves.
  IF v_terminal AND COALESCE(p_resolution_kind, v_row.resolution_kind) IS NULL THEN
    RAISE EXCEPTION 'WMS_RESOLUTION_KIND_REQUIRED: pick a resolution category to close this exception'
      USING ERRCODE='22023';
  END IF;
  IF v_terminal AND length(trim(COALESCE(p_resolution, v_row.resolution, ''))) = 0 THEN
    RAISE EXCEPTION 'WMS_RESOLUTION_NOTES_REQUIRED: resolution notes are required to close this exception'
      USING ERRCODE='22023';
  END IF;

  v_new_rv := v_row.row_version + 1;
  UPDATE public.wms_exceptions SET
    state           = p_to_state,
    row_version     = v_new_rv,
    resolution      = COALESCE(p_resolution, resolution),
    resolution_kind = COALESCE(p_resolution_kind, resolution_kind),
    resolved_by = CASE WHEN v_terminal THEN auth.uid() ELSE resolved_by END,
    resolved_at = CASE WHEN v_terminal THEN now() ELSE resolved_at END,
    updated_at  = now()
  WHERE id = p_exception_id;

  PERFORM public._wms_emit_outbox(
    'warehouse.exception.' || p_to_state::text,
    'wms.exception:' || p_exception_id::text || ':' || p_to_state::text,
    v_row.organization_id,
    v_row.business_id,
    jsonb_build_object(
      'aggregate_id',    p_exception_id,
      'warehouse_id',    v_row.warehouse_id,
      'branch_id',       v_row.branch_id,
      'actor_id',        auth.uid(),
      'occurred_at',     now(),
      'from_state',      v_from,
      'to_state',        p_to_state,
      'resolution',      p_resolution,
      'resolution_kind', COALESCE(p_resolution_kind, v_row.resolution_kind),
      'sla_breached',    (v_row.due_by IS NOT NULL AND now() > v_row.due_by)
    )
  );

  RETURN jsonb_build_object('row_version', v_new_rv, 'state', p_to_state);
END;
$function$;

-- Retire the 4-arg signature so no caller can bypass the typed close.
DROP FUNCTION IF EXISTS public.wms_resolve_exception(uuid, wms_exception_state, integer, text);

REVOKE ALL ON FUNCTION public.wms_resolve_exception(uuid, wms_exception_state, integer, text, public.wms_exception_resolution_kind) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_resolve_exception(uuid, wms_exception_state, integer, text, public.wms_exception_resolution_kind) TO authenticated, service_role;

CREATE INDEX IF NOT EXISTS idx_wms_exceptions_due_by
  ON public.wms_exceptions (warehouse_id, due_by)
  WHERE state IN ('open','acknowledged','investigating','escalated');

COMMENT ON COLUMN public.wms_exceptions.resolution_kind IS
  'Phase 4 §2 — typed root cause, required to close an exception.';
COMMENT ON COLUMN public.wms_exceptions.due_by IS
  'Phase 4 §2 — SLA deadline defaulted from kind + severity at raise time.';