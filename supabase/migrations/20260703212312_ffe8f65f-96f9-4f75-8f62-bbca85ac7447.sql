
-- =====================================================================
-- Phase 4 — Frequency-aware payroll period generator
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. New generator keyed off pay_schedules
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.payroll_periods_generate(
  _pay_schedule_id uuid,
  _from date,
  _to   date
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _s public.pay_schedules;
  _actor uuid := auth.uid();
  _count int := 0;
  _start date;
  _end date;
  _pay_date date;
  _name text;
  _fy int;
  _pn int := 0;
  _anchor int;
BEGIN
  SELECT * INTO _s FROM public.pay_schedules WHERE id = _pay_schedule_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pay_schedule % not found', _pay_schedule_id USING ERRCODE='P0002';
  END IF;

  IF _actor IS NOT NULL
     AND NOT public.user_has_module_permission(_actor, _s.organization_id, _s.business_id, 'payroll', 'write') THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE='42501';
  END IF;

  IF _from IS NULL OR _to IS NULL OR _to < _from THEN
    RAISE EXCEPTION 'invalid date range' USING ERRCODE='22023';
  END IF;

  _anchor := COALESCE(_s.anchor_day, 1);

  CASE _s.frequency
    -- ------------------------------------------------- WEEKLY ---------
    WHEN 'weekly' THEN
      _start := _from + ((_anchor - EXTRACT(ISODOW FROM _from)::int + 7) % 7);
      WHILE _start <= _to LOOP
        _end := _start + 6;
        _pn := _pn + 1;
        _pay_date := _end + COALESCE(_s.payment_offset_days, 0);
        _fy := EXTRACT(YEAR FROM _start)::int;
        _name := 'Week ' || to_char(_start, 'IW YYYY');
        INSERT INTO public.payroll_periods
          (organization_id, business_id, name, period_type, start_date, end_date,
           payment_date, fiscal_year, period_number, pay_schedule_id)
        VALUES
          (_s.organization_id, _s.business_id, _name, 'weekly', _start, _end,
           _pay_date, _fy, _pn, _s.id)
        ON CONFLICT (organization_id, business_id, start_date, end_date) DO NOTHING;
        _count := _count + 1;
        _start := _start + 7;
      END LOOP;

    -- ------------------------------------------------- BIWEEKLY -------
    WHEN 'biweekly' THEN
      _start := _from + ((_anchor - EXTRACT(ISODOW FROM _from)::int + 7) % 7);
      WHILE _start <= _to LOOP
        _end := _start + 13;
        _pn := _pn + 1;
        _pay_date := _end + COALESCE(_s.payment_offset_days, 0);
        _fy := EXTRACT(YEAR FROM _start)::int;
        _name := 'Biweekly ' || to_char(_start, 'DD Mon YYYY');
        INSERT INTO public.payroll_periods
          (organization_id, business_id, name, period_type, start_date, end_date,
           payment_date, fiscal_year, period_number, pay_schedule_id)
        VALUES
          (_s.organization_id, _s.business_id, _name, 'biweekly', _start, _end,
           _pay_date, _fy, _pn, _s.id)
        ON CONFLICT (organization_id, business_id, start_date, end_date) DO NOTHING;
        _count := _count + 1;
        _start := _start + 14;
      END LOOP;

    -- ------------------------------------------------- SEMIMONTHLY ----
    WHEN 'semimonthly' THEN
      _start := date_trunc('month', _from)::date;
      WHILE _start <= _to LOOP
        -- 1st → 15th
        _end := _start + 14;
        _pn := _pn + 1;
        _fy := EXTRACT(YEAR FROM _start)::int;
        _pay_date := _end + COALESCE(_s.payment_offset_days, 0);
        _name := 'H1 ' || to_char(_start, 'Mon YYYY');
        INSERT INTO public.payroll_periods
          (organization_id, business_id, name, period_type, start_date, end_date,
           payment_date, fiscal_year, period_number, pay_schedule_id)
        VALUES
          (_s.organization_id, _s.business_id, _name, 'semimonthly', _start, _end,
           _pay_date, _fy, _pn, _s.id)
        ON CONFLICT (organization_id, business_id, start_date, end_date) DO NOTHING;
        _count := _count + 1;
        -- 16th → end of month
        _start := _start + 15;
        _end := (date_trunc('month', _start) + INTERVAL '1 month - 1 day')::date;
        _pn := _pn + 1;
        _pay_date := _end + COALESCE(_s.payment_offset_days, 0);
        _name := 'H2 ' || to_char(_start, 'Mon YYYY');
        INSERT INTO public.payroll_periods
          (organization_id, business_id, name, period_type, start_date, end_date,
           payment_date, fiscal_year, period_number, pay_schedule_id)
        VALUES
          (_s.organization_id, _s.business_id, _name, 'semimonthly', _start, _end,
           _pay_date, _fy, _pn, _s.id)
        ON CONFLICT (organization_id, business_id, start_date, end_date) DO NOTHING;
        _count := _count + 1;
        _start := (_end + 1);
      END LOOP;

    -- ------------------------------------------------- MONTHLY --------
    WHEN 'monthly' THEN
      _start := date_trunc('month', _from)::date;
      WHILE _start <= _to LOOP
        _end := (_start + INTERVAL '1 month - 1 day')::date;
        _pn := EXTRACT(MONTH FROM _start)::int;
        _fy := EXTRACT(YEAR FROM _start)::int;
        _pay_date := _end + COALESCE(_s.payment_offset_days, 0);
        _name := to_char(_start, 'Mon YYYY');
        INSERT INTO public.payroll_periods
          (organization_id, business_id, name, period_type, start_date, end_date,
           payment_date, fiscal_year, period_number, pay_schedule_id)
        VALUES
          (_s.organization_id, _s.business_id, _name, 'monthly', _start, _end,
           _pay_date, _fy, _pn, _s.id)
        ON CONFLICT (organization_id, business_id, start_date, end_date) DO NOTHING;
        _count := _count + 1;
        _start := (_end + 1);
      END LOOP;

    -- ------------------------------------------------- QUARTERLY ------
    WHEN 'quarterly' THEN
      _start := date_trunc('quarter', _from)::date;
      WHILE _start <= _to LOOP
        _end := (_start + INTERVAL '3 months - 1 day')::date;
        _pn := EXTRACT(QUARTER FROM _start)::int;
        _fy := EXTRACT(YEAR FROM _start)::int;
        _pay_date := _end + COALESCE(_s.payment_offset_days, 0);
        _name := 'Q' || _pn || ' ' || _fy;
        INSERT INTO public.payroll_periods
          (organization_id, business_id, name, period_type, start_date, end_date,
           payment_date, fiscal_year, period_number, pay_schedule_id)
        VALUES
          (_s.organization_id, _s.business_id, _name, 'quarterly', _start, _end,
           _pay_date, _fy, _pn, _s.id)
        ON CONFLICT (organization_id, business_id, start_date, end_date) DO NOTHING;
        _count := _count + 1;
        _start := (_end + 1);
      END LOOP;

    -- ------------------------------------------------- ANNUAL ---------
    WHEN 'annual' THEN
      _start := date_trunc('year', _from)::date;
      WHILE _start <= _to LOOP
        _end := (_start + INTERVAL '1 year - 1 day')::date;
        _fy := EXTRACT(YEAR FROM _start)::int;
        _pn := 1;
        _pay_date := _end + COALESCE(_s.payment_offset_days, 0);
        _name := 'FY ' || _fy;
        INSERT INTO public.payroll_periods
          (organization_id, business_id, name, period_type, start_date, end_date,
           payment_date, fiscal_year, period_number, pay_schedule_id)
        VALUES
          (_s.organization_id, _s.business_id, _name, 'annual', _start, _end,
           _pay_date, _fy, _pn, _s.id)
        ON CONFLICT (organization_id, business_id, start_date, end_date) DO NOTHING;
        _count := _count + 1;
        _start := (_end + 1);
      END LOOP;

    ELSE
      RAISE EXCEPTION 'unsupported pay_schedules.frequency %', _s.frequency
        USING ERRCODE='22023';
  END CASE;

  RETURN _count;
END $$;

REVOKE ALL ON FUNCTION public.payroll_periods_generate(uuid, date, date) FROM public;
GRANT EXECUTE ON FUNCTION public.payroll_periods_generate(uuid, date, date) TO authenticated, service_role;

-- ---------------------------------------------------------------------
-- 2. Backfill pay_schedule_id for existing periods where the business
--    has exactly one schedule of the matching frequency
-- ---------------------------------------------------------------------
UPDATE public.payroll_periods p
   SET pay_schedule_id = s.id
  FROM public.pay_schedules s
 WHERE p.pay_schedule_id IS NULL
   AND p.business_id      = s.business_id
   AND p.period_type      = s.frequency
   AND s.is_active
   AND (SELECT count(*) FROM public.pay_schedules s2
         WHERE s2.business_id = s.business_id
           AND s2.frequency   = s.frequency
           AND s2.is_active) = 1;

-- ---------------------------------------------------------------------
-- 3. Legacy shim — keeps the old signature callable but delegates to
--    the new generator when a matching active schedule can be found.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.generate_payroll_periods(
  p_org_id      uuid,
  p_business_id uuid DEFAULT NULL,
  p_year        integer DEFAULT EXTRACT(YEAR FROM CURRENT_DATE)::int,
  p_period_type text DEFAULT 'monthly'
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _sched uuid;
  _from date := make_date(p_year, 1, 1);
  _to   date := make_date(p_year, 12, 31);
BEGIN
  SELECT id INTO _sched
    FROM public.pay_schedules
   WHERE organization_id = p_org_id
     AND (p_business_id IS NULL OR business_id = p_business_id)
     AND frequency = p_period_type
     AND is_active
   ORDER BY created_at ASC
   LIMIT 1;

  IF _sched IS NOT NULL THEN
    RETURN public.payroll_periods_generate(_sched, _from, _to);
  END IF;

  -- Fallback: legacy monthly-only path (no pay_schedule_id linkage).
  IF p_period_type <> 'monthly' THEN
    RAISE EXCEPTION 'no active pay_schedule for frequency % — create one, then retry',
      p_period_type USING ERRCODE = 'P0002';
  END IF;

  DECLARE
    v_count int := 0; v_month int; v_start date; v_end date;
  BEGIN
    FOR v_month IN 1..12 LOOP
      v_start := make_date(p_year, v_month, 1);
      v_end   := (v_start + INTERVAL '1 month - 1 day')::date;
      INSERT INTO public.payroll_periods
        (organization_id, business_id, name, period_type, start_date, end_date,
         fiscal_year, period_number)
      VALUES
        (p_org_id, p_business_id, to_char(v_start,'Mon YYYY'), 'monthly',
         v_start, v_end, p_year, v_month)
      ON CONFLICT (organization_id, business_id, start_date, end_date) DO NOTHING;
      v_count := v_count + 1;
    END LOOP;
    RETURN v_count;
  END;
END $$;
