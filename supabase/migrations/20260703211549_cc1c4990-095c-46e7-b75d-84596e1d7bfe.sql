-- Payroll Period Governance — Phase 1 (schema hardening).
DO $$ BEGIN
  CREATE TYPE public.payroll_period_status AS ENUM (
    'open','preparing','processing','awaiting_approval',
    'posted','paid','closed','reopened','cancelled','archived'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

UPDATE public.payroll_periods
   SET status = 'open'
 WHERE status IS NULL
    OR status NOT IN ('open','preparing','processing','awaiting_approval',
                      'posted','paid','closed','reopened','cancelled','archived');

DO $$
DECLARE v_type text;
BEGIN
  SELECT data_type INTO v_type
    FROM information_schema.columns
   WHERE table_schema='public' AND table_name='payroll_periods' AND column_name='status';
  IF v_type = 'text' THEN
    -- Drop the exclusion constraint that pins status as text.
    ALTER TABLE public.payroll_periods
      DROP CONSTRAINT IF EXISTS payroll_periods_no_overlap;

    ALTER TABLE public.payroll_periods ALTER COLUMN status DROP DEFAULT;
    ALTER TABLE public.payroll_periods
      ALTER COLUMN status TYPE public.payroll_period_status
      USING status::public.payroll_period_status;
    ALTER TABLE public.payroll_periods
      ALTER COLUMN status SET DEFAULT 'open'::public.payroll_period_status;

    -- Recreate the exclusion constraint on the enum-typed column.
    BEGIN
      ALTER TABLE public.payroll_periods
        ADD CONSTRAINT payroll_periods_no_overlap
        EXCLUDE USING gist (
          business_id  WITH =,
          period_type  WITH =,
          daterange(start_date, end_date, '[]') WITH &&
        ) WHERE (status <> 'cancelled'::public.payroll_period_status);
    EXCEPTION WHEN others THEN
      RAISE NOTICE 'payroll_periods_no_overlap not re-added: %', SQLERRM;
    END;
  END IF;
END $$;

DO $$
DECLARE v_bad integer;
BEGIN
  SELECT count(*) INTO v_bad FROM public.payroll_periods WHERE business_id IS NULL;
  IF v_bad = 0 THEN
    BEGIN
      ALTER TABLE public.payroll_periods ALTER COLUMN business_id SET NOT NULL;
    EXCEPTION WHEN others THEN
      RAISE NOTICE 'Could not set payroll_periods.business_id NOT NULL: %', SQLERRM;
    END;
  ELSE
    RAISE NOTICE 'payroll_periods.business_id NOT NULL not enforced; % row(s) still null', v_bad;
  END IF;
END $$;

ALTER TABLE public.payroll_periods
  ADD COLUMN IF NOT EXISTS pay_schedule_id       uuid REFERENCES public.pay_schedules(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS closed_by             uuid,
  ADD COLUMN IF NOT EXISTS closed_at             timestamptz,
  ADD COLUMN IF NOT EXISTS close_reason          text,
  ADD COLUMN IF NOT EXISTS reopened_by           uuid,
  ADD COLUMN IF NOT EXISTS reopened_at           timestamptz,
  ADD COLUMN IF NOT EXISTS reopen_reason         text,
  ADD COLUMN IF NOT EXISTS readiness_snapshot_id uuid;

CREATE INDEX IF NOT EXISTS idx_payroll_periods_pay_schedule
  ON public.payroll_periods(pay_schedule_id)
  WHERE pay_schedule_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payroll_periods_status
  ON public.payroll_periods(organization_id, business_id, status);

CREATE TABLE IF NOT EXISTS public.payroll_period_audit (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_id       uuid NOT NULL REFERENCES public.payroll_periods(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL,
  business_id     uuid NOT NULL,
  from_status     public.payroll_period_status,
  to_status       public.payroll_period_status NOT NULL,
  actor_id        uuid,
  actor_role      text,
  reason          text,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT ON public.payroll_period_audit TO authenticated;
GRANT ALL            ON public.payroll_period_audit TO service_role;

ALTER TABLE public.payroll_period_audit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS payroll_period_audit_select ON public.payroll_period_audit;
CREATE POLICY payroll_period_audit_select
  ON public.payroll_period_audit
  FOR SELECT TO authenticated
  USING (public.user_has_module_permission(auth.uid(), organization_id, 'payroll', 'read'));

DROP POLICY IF EXISTS payroll_period_audit_insert ON public.payroll_period_audit;
CREATE POLICY payroll_period_audit_insert
  ON public.payroll_period_audit
  FOR INSERT TO authenticated
  WITH CHECK (public.user_has_module_permission(auth.uid(), organization_id, 'payroll', 'write'));

CREATE INDEX IF NOT EXISTS idx_payroll_period_audit_period
  ON public.payroll_period_audit(period_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payroll_period_audit_org
  ON public.payroll_period_audit(organization_id, business_id, created_at DESC);

COMMENT ON TABLE public.payroll_period_audit IS
  'Immutable transition log for payroll periods. Written by payroll_period_transition (Phase 2).';
COMMENT ON COLUMN public.payroll_periods.status IS
  'Payroll period lifecycle. Transitions must go through payroll_period_transition (Phase 2); direct UPDATEs are deprecated.';
COMMENT ON COLUMN public.payroll_periods.pay_schedule_id IS
  'Owning pay schedule (Phase 4 drives generator + frequency alignment).';
COMMENT ON COLUMN public.payroll_periods.readiness_snapshot_id IS
  'Readiness snapshot captured at close time (Phase 2/5).';