
CREATE OR REPLACE FUNCTION public.process_leave_accruals(p_org_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_processed int := 0;
  v_skipped   int := 0;
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
BEGIN
  FOR r_lt IN
    SELECT lt.id, lt.organization_id, lt.business_id, lt.accrual_rate,
           COALESCE(lt.accrual_frequency, 'monthly') AS accrual_frequency,
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
      -- Last accrual timestamp for this employee × leave type
      SELECT MAX(created_at)
        INTO v_last_at
        FROM public.leave_allocations
       WHERE organization_id = r_lt.organization_id
         AND employee_id = r_emp.id
         AND leave_type_id = r_lt.id
         AND allocation_type = 'accrual';

      v_anchor := COALESCE(v_last_at::date, r_emp.hire_date);
      v_next_due := (v_anchor + v_interval)::date;

      IF v_next_due > v_today THEN
        v_skipped := v_skipped + 1;
        CONTINUE;
      END IF;

      v_amount := r_lt.accrual_rate;

      -- Respect carryover_limit: don't push YTD allocated above the cap.
      v_cap := r_lt.carryover_limit;
      IF v_cap IS NOT NULL AND v_cap > 0 THEN
        SELECT COALESCE(SUM(days_allocated), 0)
          INTO v_ytd
          FROM public.leave_allocations
         WHERE organization_id = r_lt.organization_id
           AND employee_id = r_emp.id
           AND leave_type_id = r_lt.id
           AND year = v_year;
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
        'Auto-accrual ('|| r_lt.accrual_frequency ||') — '|| v_amount ||' day(s) on '|| v_today,
        now()
      );

      v_processed := v_processed + 1;
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object(
    'processed', v_processed,
    'skipped',   v_skipped,
    'run_date',  v_today
  );
END;
$$;

REVOKE ALL ON FUNCTION public.process_leave_accruals(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.process_leave_accruals(uuid) TO authenticated, service_role;
