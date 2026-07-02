-- S1+S2+S3: unify POS shift-close variance enforcement around pos_override_matrix.

-- S2: seed a default shift_variance matrix row per organization that lacks one.
INSERT INTO public.pos_override_matrix
  (organization_id, business_id, action, threshold_amount, require_pin,
   restricted_roles, is_active)
SELECT DISTINCT o.id, NULL::uuid, 'shift_variance', 100, true,
       ARRAY['owner','admin','manager']::text[], true
  FROM public.organizations o
 WHERE NOT EXISTS (
   SELECT 1 FROM public.pos_override_matrix m
    WHERE m.organization_id = o.id
      AND m.action = 'shift_variance'
      AND m.business_id IS NULL
 );

-- S1: trigger reads threshold from the matrix (org+business scoped), falling
-- back to the per-shift column only if no matrix row is configured. Raises a
-- structured override_required error the UI can intercept.
CREATE OR REPLACE FUNCTION public.enforce_pos_shift_cash_variance()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  v_diff           numeric;
  v_has_override   boolean;
  v_threshold      numeric;
  v_matrix_found   boolean := false;
BEGIN
  IF public._is_teardown_for_org(COALESCE(NEW.organization_id, OLD.organization_id)) THEN
    RETURN NEW;
  END IF;

  IF NEW.status <> 'closed' OR OLD.status = 'closed' THEN
    RETURN NEW;
  END IF;

  IF NEW.actual_cash IS NULL THEN
    RAISE EXCEPTION 'Cannot close shift %: cash count is required.',
      COALESCE(NEW.shift_number, NEW.id::text)
      USING ERRCODE = 'check_violation';
  END IF;

  v_diff := COALESCE(NEW.actual_cash, 0) - COALESCE(NEW.expected_cash, 0);
  NEW.cash_difference := v_diff;

  v_has_override :=
       NEW.variance_override_pin_id IS NOT NULL
    OR NEW.variance_override_id     IS NOT NULL;

  -- Resolve authoritative threshold from pos_override_matrix (same source the
  -- close RPC's assert_manager_override() uses). Fall back to the per-shift
  -- legacy column only when no matrix row exists.
  SELECT threshold_amount, true
    INTO v_threshold, v_matrix_found
    FROM public.pos_override_matrix
   WHERE organization_id = NEW.organization_id
     AND action = 'shift_variance'
     AND is_active = true
     AND (business_id IS NULL OR business_id = NEW.business_id)
   ORDER BY business_id NULLS LAST
   LIMIT 1;

  IF NOT v_matrix_found THEN
    v_threshold := COALESCE(NEW.cash_variance_tolerance, 0);
  END IF;

  IF abs(v_diff) > COALESCE(v_threshold, 0) AND NOT v_has_override THEN
    RAISE EXCEPTION 'override_required'
      USING ERRCODE = '42501',
            HINT    = format(
              'Cash variance %s exceeds tolerance %s for shift %s. Manager override required.',
              to_char(v_diff,      'FM999G999G990D00'),
              to_char(COALESCE(v_threshold, 0), 'FM999G999G990D00'),
              COALESCE(NEW.shift_number, NEW.id::text)
            ),
            DETAIL  = jsonb_build_object(
              'action',        'shift_variance',
              'shift_id',      NEW.id,
              'shift_number',  NEW.shift_number,
              'expected_cash', NEW.expected_cash,
              'actual_cash',   NEW.actual_cash,
              'variance',      v_diff,
              'threshold',     COALESCE(v_threshold, 0)
            )::text;
  END IF;

  RETURN NEW;
END;
$function$;

-- S3: snapshot the resolved matrix threshold onto the shift at open time so
-- the legacy column remains meaningful for historical audits. Does not change
-- enforcement (the trigger already prefers the live matrix value) — it just
-- records what the threshold was when the shift began.
CREATE OR REPLACE FUNCTION public.stamp_pos_shift_variance_tolerance()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE v_threshold numeric;
BEGIN
  IF TG_OP <> 'INSERT' THEN RETURN NEW; END IF;

  SELECT threshold_amount INTO v_threshold
    FROM public.pos_override_matrix
   WHERE organization_id = NEW.organization_id
     AND action = 'shift_variance'
     AND is_active = true
     AND (business_id IS NULL OR business_id = NEW.business_id)
   ORDER BY business_id NULLS LAST
   LIMIT 1;

  IF v_threshold IS NOT NULL THEN
    NEW.cash_variance_tolerance := v_threshold;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_stamp_pos_shift_variance_tolerance ON public.pos_shifts;
CREATE TRIGGER trg_stamp_pos_shift_variance_tolerance
  BEFORE INSERT ON public.pos_shifts
  FOR EACH ROW EXECUTE FUNCTION public.stamp_pos_shift_variance_tolerance();

COMMENT ON COLUMN public.pos_shifts.cash_variance_tolerance IS
  'Historical snapshot of the shift_variance threshold (pos_override_matrix.threshold_amount) at shift open. The matrix row is the live authority used by close_pos_shift() and enforce_pos_shift_cash_variance(); this column is only consulted as a fallback when no matrix row exists.';