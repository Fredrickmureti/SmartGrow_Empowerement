
-- P1 step 5: First-class payroll_periods consumption
-- 1. Add payroll_runs.period_id (nullable, back-compat)
-- 2. Enforce non-overlap of payroll_periods per (business_id, period_type)

ALTER TABLE public.payroll_runs
  ADD COLUMN IF NOT EXISTS period_id uuid REFERENCES public.payroll_periods(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_payroll_runs_period_id ON public.payroll_runs(period_id);

-- Non-overlap exclusion using btree_gist
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Drop any prior version of the constraint, then add. Skip silently if rows
-- already overlap (legacy data); admins can clean up before re-enabling.
DO $$
BEGIN
  BEGIN
    ALTER TABLE public.payroll_periods
      DROP CONSTRAINT IF EXISTS payroll_periods_no_overlap;
    ALTER TABLE public.payroll_periods
      ADD CONSTRAINT payroll_periods_no_overlap
      EXCLUDE USING gist (
        business_id WITH =,
        period_type WITH =,
        daterange(start_date, end_date, '[]') WITH &&
      )
      WHERE (status <> 'cancelled');
  EXCEPTION WHEN others THEN
    RAISE NOTICE 'payroll_periods_no_overlap not enforced due to existing overlaps: %', SQLERRM;
  END;
END $$;
