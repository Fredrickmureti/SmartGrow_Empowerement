
-- Trigger: when a payroll run is reopened/reversed/recommitted, mark
-- certificates in the same fiscal year as stale (Step 2 wiring, B1).
CREATE OR REPLACE FUNCTION public.payroll_runs_mark_certs_stale()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_year integer;
  v_reason text;
BEGIN
  v_year := EXTRACT(YEAR FROM COALESCE(NEW.pay_period_end, OLD.pay_period_end))::int;
  IF v_year IS NULL THEN RETURN NEW; END IF;

  -- Stale triggers: status flips back to draft, reversal lands, posted_at clears,
  -- or committed/locked/posted timestamps shift after issuance.
  IF TG_OP = 'UPDATE' AND (
       (OLD.status IS DISTINCT FROM NEW.status)
    OR (OLD.reversed_at IS DISTINCT FROM NEW.reversed_at)
    OR (OLD.posted_at IS DISTINCT FROM NEW.posted_at)
    OR (OLD.locked_at IS DISTINCT FROM NEW.locked_at)
    OR (OLD.approved_at IS DISTINCT FROM NEW.approved_at)
  ) THEN
    v_reason := format(
      'payroll_run %s changed (%s → %s)',
      NEW.id, OLD.status, NEW.status
    );

    WITH flipped AS (
      UPDATE public.payroll_tax_certificates c
         SET stale = true,
             stale_reason = v_reason,
             stale_at = now()
       WHERE c.organization_id = NEW.organization_id
         AND c.business_id    = NEW.business_id
         AND c.fiscal_year    = v_year
         AND c.status         = 'issued'
         AND COALESCE(c.stale, false) = false
       RETURNING c.id, c.organization_id, c.business_id
    )
    INSERT INTO public.payroll_tax_certificate_events
      (certificate_id, organization_id, business_id, event_type, actor_user_id, details)
    SELECT f.id, f.organization_id, f.business_id, 'marked_stale', NULL,
           jsonb_build_object('payroll_run_id', NEW.id, 'reason', v_reason)
    FROM flipped f;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_payroll_runs_mark_certs_stale ON public.payroll_runs;
CREATE TRIGGER trg_payroll_runs_mark_certs_stale
AFTER UPDATE ON public.payroll_runs
FOR EACH ROW EXECUTE FUNCTION public.payroll_runs_mark_certs_stale();

-- Trigger: when a retroactive correction lands, mark the employee's
-- certificates in that fiscal year as stale.
CREATE OR REPLACE FUNCTION public.payroll_corrections_mark_certs_stale()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_year integer;
  v_org uuid;
  v_biz uuid;
  v_emp uuid;
BEGIN
  -- payroll_correction_adjustments columns vary; resolve via the linked run
  SELECT EXTRACT(YEAR FROM r.pay_period_end)::int, r.organization_id, r.business_id
    INTO v_year, v_org, v_biz
  FROM public.payroll_runs r
  WHERE r.id = (
    CASE
      WHEN to_jsonb(NEW) ? 'payroll_run_id' THEN (to_jsonb(NEW) ->> 'payroll_run_id')::uuid
      WHEN to_jsonb(NEW) ? 'run_id'         THEN (to_jsonb(NEW) ->> 'run_id')::uuid
      ELSE NULL
    END
  );

  IF v_year IS NULL OR v_org IS NULL THEN RETURN NEW; END IF;

  v_emp := CASE
    WHEN to_jsonb(NEW) ? 'employee_id' THEN (to_jsonb(NEW) ->> 'employee_id')::uuid
    ELSE NULL
  END;

  WITH flipped AS (
    UPDATE public.payroll_tax_certificates c
       SET stale = true,
           stale_reason = 'payroll correction adjustment landed after issuance',
           stale_at = now()
     WHERE c.organization_id = v_org
       AND c.business_id    = v_biz
       AND c.fiscal_year    = v_year
       AND c.status         = 'issued'
       AND COALESCE(c.stale, false) = false
       AND (v_emp IS NULL OR c.employee_id = v_emp)
     RETURNING c.id, c.organization_id, c.business_id
  )
  INSERT INTO public.payroll_tax_certificate_events
    (certificate_id, organization_id, business_id, event_type, actor_user_id, details)
  SELECT f.id, f.organization_id, f.business_id, 'marked_stale', NULL,
         jsonb_build_object('correction_id', NEW.id, 'source', 'payroll_correction_adjustments')
  FROM flipped f;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_payroll_corrections_mark_certs_stale ON public.payroll_correction_adjustments;
CREATE TRIGGER trg_payroll_corrections_mark_certs_stale
AFTER INSERT ON public.payroll_correction_adjustments
FOR EACH ROW EXECUTE FUNCTION public.payroll_corrections_mark_certs_stale();
