-- Phase 3.4-followup #6 — Correction-adjuster ledger inversion RPC
-- Symmetric counterpart to compute-payroll's V2 forward path. Called by
-- reverse-payroll *after* payroll_reverse_run_atomic succeeds. Inserts
-- negated ledger rows tied to the reversal run and re-applies the
-- inverse delta to employee_garnishments.total_paid with clamping.
-- Idempotent: the unique constraint on
-- (payroll_run_id, source_kind, source_id) makes re-invocation a no-op.

CREATE OR REPLACE FUNCTION public.payroll_invert_correction_adjustments(
  _original_run_id uuid,
  _reversal_run_id uuid,
  _user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inverted int := 0;
  v_garn_updated int := 0;
  v_rec record;
  v_new_paid numeric;
BEGIN
  IF _original_run_id IS NULL THEN
    RAISE EXCEPTION 'original_run_id required' USING HINT = 'BAD_INPUT';
  END IF;

  -- Insert negated ledger rows for every forward entry on the original run.
  -- ON CONFLICT DO NOTHING makes the call idempotent — repeated reversal
  -- attempts (or replays of the edge fn) cannot double-invert.
  IF _reversal_run_id IS NOT NULL THEN
    INSERT INTO public.payroll_correction_adjustments (
      organization_id, business_id, payroll_run_id, parent_run_id,
      employee_id, source_kind, source_id, signed_amount, applied_by, notes
    )
    SELECT
      organization_id, business_id, _reversal_run_id, payroll_run_id,
      employee_id, source_kind, source_id, -signed_amount, _user_id,
      'Inversion of correction run ' || _original_run_id::text
    FROM public.payroll_correction_adjustments
    WHERE payroll_run_id = _original_run_id
    ON CONFLICT (payroll_run_id, source_kind, source_id) DO NOTHING;
    GET DIAGNOSTICS v_inverted = ROW_COUNT;
  END IF;

  -- Apply inverse delta to garnishments with clamp [0, total_amount].
  FOR v_rec IN
    SELECT source_id, SUM(signed_amount) AS delta
    FROM public.payroll_correction_adjustments
    WHERE payroll_run_id = _original_run_id
      AND source_kind = 'garnishment'
    GROUP BY source_id
  LOOP
    UPDATE public.employee_garnishments g
    SET total_paid = LEAST(
      COALESCE(g.total_amount, GREATEST(g.total_paid - v_rec.delta, 0)),
      GREATEST(COALESCE(g.total_paid, 0) - v_rec.delta, 0)
    )
    WHERE g.id = v_rec.source_id;
    IF FOUND THEN
      v_garn_updated := v_garn_updated + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'inverted', v_inverted,
    'garnishments_updated', v_garn_updated,
    'original_run_id', _original_run_id,
    'reversal_run_id', _reversal_run_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.payroll_invert_correction_adjustments(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.payroll_invert_correction_adjustments(uuid, uuid, uuid) TO service_role;

COMMENT ON FUNCTION public.payroll_invert_correction_adjustments(uuid, uuid, uuid) IS
  'Phase 3.4-followup #6 — symmetric inverse of compute-payroll Turn-C V2 path. Inserts negated ledger rows tied to the reversal run and re-applies inverse deltas to garnishments. Idempotent.';