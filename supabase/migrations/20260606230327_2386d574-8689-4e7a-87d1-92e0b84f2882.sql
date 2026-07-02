
-- 1. Leave accrual anchors
ALTER TABLE public.leave_types
  ADD COLUMN IF NOT EXISTS accrual_anchor text NOT NULL DEFAULT 'hire_date'
    CHECK (accrual_anchor IN ('hire_date','calendar','anniversary'));

CREATE OR REPLACE FUNCTION public.process_leave_accruals(p_org_id uuid DEFAULT NULL::uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_processed int := 0;
  v_skipped   int := 0;
  v_expired   int := 0;
  v_today     date := current_date;
  v_year      int  := extract(year FROM v_today)::int;
  r_emp       record;
  r_lt        record;
  v_last_at   timestamptz;
  v_anchor    date;
  v_interval  interval;
  v_next_due  date;
  v_ytd       numeric;
  v_amount    numeric;
  v_cap       numeric;
  v_period_start date;
  v_deadline_mmdd text;
  v_deadline_date date;
BEGIN
  -- Phase 1: expire carryover allocations whose carryover_deadline (mm-dd)
  -- has passed for the current year. Mark them with a synthetic 'expiry'
  -- adjustment so days_allocated is reduced.
  FOR r_lt IN
    SELECT id, organization_id, carryover_deadline
      FROM public.leave_types
     WHERE COALESCE(is_active, true) = true
       AND COALESCE(carryover_enabled, false) = true
       AND carryover_deadline IS NOT NULL
       AND (p_org_id IS NULL OR organization_id = p_org_id)
  LOOP
    v_deadline_mmdd := r_lt.carryover_deadline;
    BEGIN
      v_deadline_date := to_date(v_year::text || '-' || v_deadline_mmdd, 'YYYY-MM-DD');
    EXCEPTION WHEN OTHERS THEN
      CONTINUE;
    END;
    IF v_today > v_deadline_date THEN
      INSERT INTO public.leave_allocations (
        organization_id, business_id, employee_id, leave_type_id,
        allocation_type, year, days_allocated, days_used, days_pending,
        effective_date, notes, approved_at
      )
      SELECT a.organization_id, a.business_id, a.employee_id, a.leave_type_id,
             'carryover_expiry', v_year,
             -1 * GREATEST(0, COALESCE(SUM(a.days_allocated - a.days_used - a.days_pending), 0)),
             0, 0, v_today,
             'Carryover expired on '||v_deadline_date, now()
        FROM public.leave_allocations a
       WHERE a.organization_id = r_lt.organization_id
         AND a.leave_type_id = r_lt.id
         AND a.year < v_year
         AND a.allocation_type IN ('initial','accrual','carryover')
         AND NOT EXISTS (
           SELECT 1 FROM public.leave_allocations x
            WHERE x.organization_id = a.organization_id
              AND x.employee_id = a.employee_id
              AND x.leave_type_id = a.leave_type_id
              AND x.allocation_type = 'carryover_expiry'
              AND x.year = v_year
         )
       GROUP BY a.organization_id, a.business_id, a.employee_id, a.leave_type_id
      HAVING SUM(a.days_allocated - a.days_used - a.days_pending) > 0;
      GET DIAGNOSTICS v_expired = ROW_COUNT;
    END IF;
  END LOOP;

  -- Phase 2: accrue
  FOR r_lt IN
    SELECT lt.id, lt.organization_id, lt.business_id, lt.accrual_rate,
           COALESCE(lt.accrual_frequency, 'monthly') AS accrual_frequency,
           COALESCE(lt.accrual_anchor, 'hire_date') AS accrual_anchor,
           lt.carryover_enabled, lt.carryover_limit
      FROM public.leave_types lt
     WHERE lt.accrual_enabled = true
       AND COALESCE(lt.is_active, true) = true
       AND COALESCE(lt.accrual_rate, 0) > 0
       AND (p_org_id IS NULL OR lt.organization_id = p_org_id)
  LOOP
    v_interval := CASE r_lt.accrual_frequency
                    WHEN 'monthly'     THEN INTERVAL '1 month'
                    WHEN 'quarterly'   THEN INTERVAL '3 months'
                    WHEN 'semi_annual' THEN INTERVAL '6 months'
                    WHEN 'annual'      THEN INTERVAL '1 year'
                    ELSE INTERVAL '1 month'
                  END;

    FOR r_emp IN
      SELECT e.id, e.business_id, e.hire_date
        FROM public.employees e
       WHERE e.organization_id = r_lt.organization_id
         AND COALESCE(e.is_active, true) = true
         AND e.termination_date IS NULL
         AND (r_lt.business_id IS NULL OR e.business_id = r_lt.business_id)
         AND e.hire_date IS NOT NULL
         AND e.hire_date <= v_today
    LOOP
      SELECT MAX(created_at)
        INTO v_last_at
        FROM public.leave_allocations
       WHERE organization_id = r_lt.organization_id
         AND employee_id = r_emp.id
         AND leave_type_id = r_lt.id
         AND allocation_type = 'accrual';

      -- Anchor resolution
      IF r_lt.accrual_anchor = 'calendar' THEN
        -- Anchor to start of current period (calendar-aligned)
        v_period_start := CASE r_lt.accrual_frequency
          WHEN 'monthly'     THEN date_trunc('month',   v_today)::date
          WHEN 'quarterly'   THEN date_trunc('quarter', v_today)::date
          WHEN 'semi_annual' THEN make_date(v_year, CASE WHEN extract(month FROM v_today) <= 6 THEN 1 ELSE 7 END, 1)
          WHEN 'annual'      THEN date_trunc('year',    v_today)::date
          ELSE date_trunc('month', v_today)::date
        END;
        v_anchor := COALESCE(v_last_at::date, v_period_start - 1);
        v_next_due := CASE WHEN v_last_at IS NULL THEN v_period_start ELSE (v_anchor + v_interval)::date END;
      ELSIF r_lt.accrual_anchor = 'anniversary' THEN
        -- Anchor to employee anniversary; only accrue once per cycle starting at anniversary.
        v_anchor := COALESCE(v_last_at::date, make_date(v_year, extract(month FROM r_emp.hire_date)::int, extract(day FROM r_emp.hire_date)::int));
        IF v_last_at IS NULL AND v_anchor > v_today THEN
          v_anchor := v_anchor - INTERVAL '1 year';
        END IF;
        v_next_due := (v_anchor + v_interval)::date;
      ELSE
        -- 'hire_date' default — preserve previous behaviour
        v_anchor := COALESCE(v_last_at::date, r_emp.hire_date);
        v_next_due := (v_anchor + v_interval)::date;
      END IF;

      IF v_next_due > v_today THEN
        v_skipped := v_skipped + 1;
        CONTINUE;
      END IF;

      v_amount := r_lt.accrual_rate;

      v_cap := r_lt.carryover_limit;
      IF v_cap IS NOT NULL AND v_cap > 0 THEN
        SELECT COALESCE(SUM(days_allocated), 0)
          INTO v_ytd
          FROM public.leave_allocations
         WHERE organization_id = r_lt.organization_id
           AND employee_id = r_emp.id
           AND leave_type_id = r_lt.id
           AND year = v_year
           AND allocation_type IN ('initial','accrual','carryover');
        IF v_ytd >= v_cap THEN
          v_skipped := v_skipped + 1;
          CONTINUE;
        END IF;
        v_amount := LEAST(v_amount, v_cap - v_ytd);
      END IF;

      IF v_amount <= 0 THEN
        v_skipped := v_skipped + 1;
        CONTINUE;
      END IF;

      INSERT INTO public.leave_allocations (
        organization_id, business_id, employee_id, leave_type_id,
        allocation_type, year, days_allocated, days_used, days_pending,
        effective_date, notes, approved_at
      ) VALUES (
        r_lt.organization_id,
        COALESCE(r_emp.business_id, r_lt.business_id),
        r_emp.id,
        r_lt.id,
        'accrual',
        v_year,
        v_amount,
        0,
        0,
        v_today,
        'Auto-accrual ('|| r_lt.accrual_frequency ||', anchor='||r_lt.accrual_anchor||') — '|| v_amount ||' day(s)',
        now()
      );

      v_processed := v_processed + 1;
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object(
    'processed', v_processed,
    'skipped',   v_skipped,
    'expired',   v_expired,
    'run_date',  v_today
  );
END;
$function$;

-- 2. Self-service idempotency
ALTER TABLE public.leave_requests ADD COLUMN IF NOT EXISTS idempotency_key text;
ALTER TABLE public.employee_loans  ADD COLUMN IF NOT EXISTS idempotency_key text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_leave_requests_idempotency
  ON public.leave_requests(organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_employee_loans_idempotency
  ON public.employee_loans(organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- 3. Localization-pack guard for payroll runs
CREATE OR REPLACE FUNCTION public.assert_localization_pack_for_org(p_org_id uuid)
RETURNS void
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.installed_localization_packs
     WHERE organization_id = p_org_id
       AND status = 'active'
  ) THEN
    RAISE EXCEPTION 'No active localization pack installed for this organization'
      USING HINT = 'PAYROLL_NO_LOCALIZATION_PACK';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.payroll_run_require_localization_pack()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.status IN ('computing','computed','approved','paid') THEN
    IF TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status THEN
      PERFORM public.assert_localization_pack_for_org(NEW.organization_id);
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_payroll_run_require_localization ON public.payroll_runs;
CREATE TRIGGER trg_payroll_run_require_localization
  BEFORE INSERT OR UPDATE ON public.payroll_runs
  FOR EACH ROW EXECUTE FUNCTION public.payroll_run_require_localization_pack();
