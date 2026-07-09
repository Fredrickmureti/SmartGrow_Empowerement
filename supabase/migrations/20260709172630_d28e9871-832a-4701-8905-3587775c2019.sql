
-- ============================================================
-- D6 — Cross-module freeze enforcement
-- ============================================================

CREATE OR REPLACE FUNCTION public.enforce_physical_count_freeze()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_override text;
BEGIN
  -- Exempt the physical count posting itself.
  IF NEW.reference_type = 'physical_count' THEN
    RETURN NEW;
  END IF;

  -- Session-level manager override (set by the caller RPC before writing).
  BEGIN
    v_override := current_setting('app.physical_count_freeze_override', true);
  EXCEPTION WHEN OTHERS THEN
    v_override := NULL;
  END;
  IF v_override = 'on' THEN
    RETURN NEW;
  END IF;

  IF NEW.warehouse_id IS NULL OR NEW.product_id IS NULL OR NEW.organization_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF public.is_product_frozen(NEW.organization_id, NEW.warehouse_id, NEW.product_id) THEN
    RAISE EXCEPTION 'E_PC_WAREHOUSE_FROZEN: product % in warehouse % is locked by an in-progress physical count. Complete or cancel the count, or ask a manager to issue a freeze override.',
      NEW.product_id, NEW.warehouse_id
      USING ERRCODE = 'P0001',
            HINT   = 'PHYSICAL_COUNT_FREEZE';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS enforce_physical_count_freeze_trg ON public.stock_movements;
CREATE TRIGGER enforce_physical_count_freeze_trg
  BEFORE INSERT ON public.stock_movements
  FOR EACH ROW EXECUTE FUNCTION public.enforce_physical_count_freeze();

COMMENT ON FUNCTION public.enforce_physical_count_freeze() IS
  'BEFORE INSERT trigger on stock_movements. Blocks non-physical-count writes against a (warehouse, product) that has an in-progress count. Set app.physical_count_freeze_override=on inside a transaction for a scoped manager override.';

-- ============================================================
-- D7 — Cycle-count scheduler
-- ============================================================

CREATE TABLE IF NOT EXISTS public.cycle_count_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid,
  branch_id uuid,
  warehouse_id uuid NOT NULL REFERENCES public.warehouses(id) ON DELETE CASCADE,
  name text NOT NULL,
  cadence text NOT NULL CHECK (cadence IN ('daily','weekly','biweekly','monthly','quarterly')),
  scope_type text NOT NULL DEFAULT 'warehouse'
    CHECK (scope_type IN ('warehouse','abc_class','category','product_list')),
  abc_class text CHECK (abc_class IN ('A','B','C')),
  category_id uuid,
  product_ids uuid[],
  tolerance_pct numeric(6,2),
  tolerance_value numeric(18,2),
  auto_freeze boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  next_run_at timestamptz NOT NULL DEFAULT now(),
  last_run_at timestamptz,
  last_generated_count_id uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.cycle_count_schedules TO authenticated;
GRANT ALL ON public.cycle_count_schedules TO service_role;

ALTER TABLE public.cycle_count_schedules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "cycle_count_schedules_org_read"
  ON public.cycle_count_schedules FOR SELECT
  TO authenticated
  USING (organization_id IN (
    SELECT organization_id FROM public.profiles WHERE id = auth.uid()
  ));

CREATE POLICY "cycle_count_schedules_org_manage"
  ON public.cycle_count_schedules FOR ALL
  TO authenticated
  USING (organization_id IN (
    SELECT organization_id FROM public.profiles WHERE id = auth.uid()
  ))
  WITH CHECK (organization_id IN (
    SELECT organization_id FROM public.profiles WHERE id = auth.uid()
  ));

CREATE INDEX IF NOT EXISTS idx_cycle_count_schedules_due
  ON public.cycle_count_schedules (next_run_at) WHERE active;
CREATE INDEX IF NOT EXISTS idx_cycle_count_schedules_org
  ON public.cycle_count_schedules (organization_id, warehouse_id);

CREATE TRIGGER trg_cycle_count_schedules_updated_at
  BEFORE UPDATE ON public.cycle_count_schedules
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE OR REPLACE FUNCTION public.advance_cycle_count_next_run(_cadence text, _from timestamptz)
RETURNS timestamptz LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE _cadence
    WHEN 'daily'     THEN _from + interval '1 day'
    WHEN 'weekly'    THEN _from + interval '7 days'
    WHEN 'biweekly'  THEN _from + interval '14 days'
    WHEN 'monthly'   THEN _from + interval '1 month'
    WHEN 'quarterly' THEN _from + interval '3 months'
    ELSE _from + interval '1 day'
  END;
$$;

CREATE OR REPLACE FUNCTION public.generate_due_cycle_counts(p_now timestamptz DEFAULT now())
RETURNS TABLE(schedule_id uuid, count_id uuid, count_number text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_sched RECORD;
  v_count_id uuid;
  v_count_number text;
BEGIN
  FOR v_sched IN
    SELECT * FROM public.cycle_count_schedules
     WHERE active AND next_run_at <= p_now
     ORDER BY next_run_at
     FOR UPDATE SKIP LOCKED
  LOOP
    v_count_number := 'CYC-' || to_char(p_now, 'YYYYMMDD') || '-' || substr(v_sched.id::text, 1, 8);

    INSERT INTO public.physical_counts (
      organization_id, business_id, branch_id, warehouse_id,
      count_number, count_date, count_type, state,
      tolerance_pct, tolerance_value, notes, created_by
    ) VALUES (
      v_sched.organization_id, v_sched.business_id, v_sched.branch_id, v_sched.warehouse_id,
      v_count_number, p_now::date, 'cycle', 'draft',
      v_sched.tolerance_pct, v_sched.tolerance_value,
      'Auto-generated from cycle schedule: ' || v_sched.name,
      v_sched.created_by
    ) RETURNING id INTO v_count_id;

    UPDATE public.cycle_count_schedules
       SET last_run_at              = p_now,
           last_generated_count_id  = v_count_id,
           next_run_at              = public.advance_cycle_count_next_run(v_sched.cadence, p_now)
     WHERE id = v_sched.id;

    schedule_id  := v_sched.id;
    count_id     := v_count_id;
    count_number := v_count_number;
    RETURN NEXT;
  END LOOP;
END $$;

GRANT EXECUTE ON FUNCTION public.generate_due_cycle_counts(timestamptz) TO authenticated, service_role;

COMMENT ON TABLE public.cycle_count_schedules IS
  'Recurring cycle-count schedules. Drives generate_due_cycle_counts() which is invoked by pg_cron or an edge function.';

-- ============================================================
-- D8 — Retire the legacy shim
-- ============================================================

DROP FUNCTION IF EXISTS public.apply_physical_count_atomic(uuid, uuid, jsonb);
DROP FUNCTION IF EXISTS public.apply_physical_count_atomic(uuid, uuid);
DROP FUNCTION IF EXISTS public.apply_physical_count_atomic(jsonb);
DROP FUNCTION IF EXISTS public.apply_physical_count_atomic;
