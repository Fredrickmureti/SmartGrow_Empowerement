
-- =====================================================================
-- Payroll Batches (Phase 1) — Foundation for ADR-0045 Payroll Control Record
--
-- Reshapes payroll_run_groups from a passive "tag-after-the-fact" folder
-- into the schema substrate for a first-class Payroll Batch / Control
-- Record. Behaviour is preserved for existing rows; lifecycle RPCs that
-- exercise the new columns ship in Phase 2.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Schema additions
-- ---------------------------------------------------------------------
ALTER TABLE public.payroll_run_groups
  ADD COLUMN IF NOT EXISTS business_id                   uuid NULL,
  ADD COLUMN IF NOT EXISTS pay_schedule_id               uuid NULL REFERENCES public.pay_schedules(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS country_code                  text NULL,
  ADD COLUMN IF NOT EXISTS batch_number                  text NULL,
  ADD COLUMN IF NOT EXISTS run_type                      text NOT NULL DEFAULT 'regular',
  ADD COLUMN IF NOT EXISTS parent_batch_id               uuid NULL REFERENCES public.payroll_run_groups(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS locked_at                     timestamptz NULL,
  ADD COLUMN IF NOT EXISTS approved_by                   uuid NULL,
  ADD COLUMN IF NOT EXISTS approved_at                   timestamptz NULL,
  ADD COLUMN IF NOT EXISTS posted_by                     uuid NULL,
  ADD COLUMN IF NOT EXISTS posted_at                     timestamptz NULL,
  ADD COLUMN IF NOT EXISTS consolidated_journal_entry_id uuid NULL REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS paid_by                       uuid NULL,
  ADD COLUMN IF NOT EXISTS paid_at                       timestamptz NULL,
  ADD COLUMN IF NOT EXISTS payment_batch_id              uuid NULL REFERENCES public.payroll_payment_batches(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS closed_at                     timestamptz NULL,
  ADD COLUMN IF NOT EXISTS reversal_batch_id             uuid NULL REFERENCES public.payroll_run_groups(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS idempotency_key               text NULL,
  ADD COLUMN IF NOT EXISTS readiness_snapshot_id         uuid NULL;

-- ---------------------------------------------------------------------
-- 2. Backfill business_id from first child run (single-entity invariant)
-- ---------------------------------------------------------------------
UPDATE public.payroll_run_groups g
   SET business_id = sub.business_id
  FROM (
    SELECT DISTINCT ON (group_id) group_id, business_id
      FROM public.payroll_runs
     WHERE group_id IS NOT NULL
       AND business_id IS NOT NULL
     ORDER BY group_id, created_at ASC NULLS LAST
  ) sub
 WHERE g.id = sub.group_id
   AND g.business_id IS NULL;

-- Backfill a synthetic batch_number for legacy rows so the NOT NULL
-- constraint below holds. Format mirrors the BATCH-YYYYMM-#### shape the
-- Phase 2 RPC will issue (legacy rows get a "-L" suffix for traceability).
WITH numbered AS (
  SELECT id,
         organization_id,
         to_char(period_start, 'YYYYMM') AS yyyymm,
         row_number() OVER (
           PARTITION BY organization_id, COALESCE(business_id, '00000000-0000-0000-0000-000000000000'::uuid), to_char(period_start, 'YYYYMM')
           ORDER BY created_at ASC
         ) AS rn
    FROM public.payroll_run_groups
   WHERE batch_number IS NULL
)
UPDATE public.payroll_run_groups g
   SET batch_number = 'BATCH-' || numbered.yyyymm || '-' || lpad(numbered.rn::text, 4, '0') || '-L'
  FROM numbered
 WHERE g.id = numbered.id;

-- Backfill idempotency_key for legacy rows (only meaningful once business_id is set).
UPDATE public.payroll_run_groups
   SET idempotency_key = 'legacy:' || id::text
 WHERE idempotency_key IS NULL;

-- ---------------------------------------------------------------------
-- 3. NOT NULL + UNIQUE invariants (after backfill)
-- ---------------------------------------------------------------------
-- batch_number / idempotency_key are universally backfilled, safe to lock.
ALTER TABLE public.payroll_run_groups
  ALTER COLUMN batch_number    SET NOT NULL,
  ALTER COLUMN idempotency_key SET NOT NULL;

-- business_id is NOT NULL for batches created from Phase 2 onward.
-- Legacy rows without children may remain NULL; the lifecycle trigger
-- below forbids advancing such a row past 'draft', which is the
-- enforcement point. Adding a hard NOT NULL would orphan legacy rows.
-- A pgTAP test in Phase 1 pins this contract.

CREATE UNIQUE INDEX IF NOT EXISTS payroll_run_groups_idempotency_key_uidx
  ON public.payroll_run_groups(idempotency_key);

-- Prevent duplicate active batches for the same (org, business, schedule,
-- period, run_type). cancelled / reversed batches are excluded so a
-- replacement batch can be opened after a reversal.
CREATE UNIQUE INDEX IF NOT EXISTS payroll_run_groups_active_period_uidx
  ON public.payroll_run_groups (
    organization_id,
    business_id,
    COALESCE(pay_schedule_id, '00000000-0000-0000-0000-000000000000'::uuid),
    period_start,
    period_end,
    run_type
  )
  WHERE business_id IS NOT NULL
    AND status NOT IN ('cancelled', 'reversed');

CREATE INDEX IF NOT EXISTS payroll_run_groups_business_period_idx
  ON public.payroll_run_groups(organization_id, business_id, period_end DESC)
  WHERE business_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS payroll_run_groups_parent_idx
  ON public.payroll_run_groups(parent_batch_id)
  WHERE parent_batch_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- 4. Lifecycle invariants (table-tier per ADR-0022)
--
-- Canonical lifecycle:
--   draft → computing → review → approved → posted → paid → closed
--                                              ↘ cancelled (pre-post only)
--   posted | paid | closed → reversed (sibling reversal batch wires reversal_batch_id)
--
-- A single SECURITY DEFINER trigger enforces:
--   - run_type membership
--   - status membership + transition matrix
--   - parent_batch_id only for correction/supplemental/off_cycle
--   - period sanity (end >= start)
--   - legacy rows (business_id IS NULL) cannot leave 'draft'
--   - self-reference guards on parent_batch_id / reversal_batch_id
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.validate_payroll_batch_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_allowed_run_types  text[] := ARRAY['regular','13th_month','termination','bonus','off_cycle','correction','supplemental'];
  v_allowed_statuses   text[] := ARRAY['draft','computing','review','approved','posted','paid','closed','cancelled','reversed'];
  v_terminal_statuses  text[] := ARRAY['closed','cancelled','reversed'];
  v_post_post_statuses text[] := ARRAY['posted','paid','closed'];
BEGIN
  -- Membership
  IF NEW.run_type IS NULL OR NOT (NEW.run_type = ANY (v_allowed_run_types)) THEN
    RAISE EXCEPTION 'payroll_batch_invalid_run_type: %', NEW.run_type
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status IS NULL OR NOT (NEW.status = ANY (v_allowed_statuses)) THEN
    RAISE EXCEPTION 'payroll_batch_invalid_status: %', NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  -- Period sanity
  IF NEW.period_end < NEW.period_start THEN
    RAISE EXCEPTION 'payroll_batch_period_inverted: period_end (%) < period_start (%)',
      NEW.period_end, NEW.period_start
      USING ERRCODE = 'check_violation';
  END IF;

  -- parent_batch_id is reserved for correction / supplemental / off_cycle
  IF NEW.parent_batch_id IS NOT NULL
     AND NEW.run_type NOT IN ('correction','supplemental','off_cycle') THEN
    RAISE EXCEPTION 'payroll_batch_parent_not_allowed_for_run_type: %', NEW.run_type
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.parent_batch_id IS NOT NULL AND NEW.parent_batch_id = NEW.id THEN
    RAISE EXCEPTION 'payroll_batch_parent_self_reference'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.reversal_batch_id IS NOT NULL AND NEW.reversal_batch_id = NEW.id THEN
    RAISE EXCEPTION 'payroll_batch_reversal_self_reference'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Phase 1: legacy rows (business_id NULL) are frozen at 'draft'. They
  -- will be reconciled by the Phase 6 admin tool; the engine never
  -- advances them past draft because every Phase 2 RPC creates fresh
  -- rows with business_id populated.
  IF NEW.business_id IS NULL AND NEW.status <> 'draft' THEN
    RAISE EXCEPTION 'payroll_batch_legacy_row_frozen_at_draft'
      USING ERRCODE = 'check_violation',
            HINT    = 'Legacy run groups without a business_id cannot advance lifecycle. Reconcile via the Phase 6 admin tool.';
  END IF;

  -- Transition matrix (UPDATE only)
  IF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
    -- Terminal states never transition out
    IF OLD.status = ANY (v_terminal_statuses) THEN
      RAISE EXCEPTION 'payroll_batch_terminal_state_immutable: % → %', OLD.status, NEW.status
        USING ERRCODE = 'check_violation';
    END IF;

    IF NOT (
         (OLD.status = 'draft'      AND NEW.status IN ('computing','review','cancelled'))
      OR (OLD.status = 'computing'  AND NEW.status IN ('review','draft','cancelled'))
      OR (OLD.status = 'review'     AND NEW.status IN ('approved','draft','cancelled'))
      OR (OLD.status = 'approved'   AND NEW.status IN ('posted','review','cancelled'))
      OR (OLD.status = 'posted'     AND NEW.status IN ('paid','reversed'))
      OR (OLD.status = 'paid'       AND NEW.status IN ('closed','reversed'))
    ) THEN
      RAISE EXCEPTION 'payroll_batch_invalid_transition: % → %', OLD.status, NEW.status
        USING ERRCODE = 'check_violation',
              HINT    = 'See lifecycle matrix in validate_payroll_batch_lifecycle.';
    END IF;
  END IF;

  -- Pinned audit columns: post-post-post-state implies actor stamps.
  IF NEW.status = ANY (v_post_post_statuses) THEN
    IF NEW.approved_by IS NULL OR NEW.approved_at IS NULL THEN
      RAISE EXCEPTION 'payroll_batch_missing_approval_audit'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW.status IN ('posted','paid','closed') THEN
    IF NEW.posted_by IS NULL OR NEW.posted_at IS NULL THEN
      RAISE EXCEPTION 'payroll_batch_missing_post_audit'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW.status IN ('paid','closed') THEN
    IF NEW.paid_by IS NULL OR NEW.paid_at IS NULL THEN
      RAISE EXCEPTION 'payroll_batch_missing_paid_audit'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_validate_payroll_batch_lifecycle ON public.payroll_run_groups;
CREATE TRIGGER trg_validate_payroll_batch_lifecycle
  BEFORE INSERT OR UPDATE ON public.payroll_run_groups
  FOR EACH ROW EXECUTE FUNCTION public.validate_payroll_batch_lifecycle();

-- ---------------------------------------------------------------------
-- 5. Convenience view — surfaces the batch shape under its target name
--    without renaming the physical table (avoids breaking the existing
--    hook + types). Phase 5 UI reads from this view.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_payroll_batches AS
SELECT
  g.id,
  g.organization_id,
  g.business_id,
  g.pay_schedule_id,
  g.country_code,
  g.batch_number,
  g.name,
  g.run_type,
  g.status,
  g.period_start,
  g.period_end,
  g.parent_batch_id,
  g.reversal_batch_id,
  g.locked_at,
  g.approved_by,
  g.approved_at,
  g.posted_by,
  g.posted_at,
  g.consolidated_journal_entry_id,
  g.paid_by,
  g.paid_at,
  g.payment_batch_id,
  g.closed_at,
  g.idempotency_key,
  g.readiness_snapshot_id,
  g.notes,
  g.created_by,
  g.created_at,
  g.updated_at,
  (SELECT count(*) FROM public.payroll_runs r WHERE r.group_id = g.id) AS child_run_count,
  (SELECT COALESCE(sum(r.employee_count), 0) FROM public.payroll_runs r WHERE r.group_id = g.id) AS headcount,
  (SELECT COALESCE(sum(r.total_gross), 0) FROM public.payroll_runs r WHERE r.group_id = g.id) AS total_gross,
  (SELECT COALESCE(sum(r.total_net), 0)   FROM public.payroll_runs r WHERE r.group_id = g.id) AS total_net,
  (SELECT COALESCE(sum(r.total_employer_contributions), 0)
     FROM public.payroll_runs r WHERE r.group_id = g.id)              AS total_employer_contributions
FROM public.payroll_run_groups g;

GRANT SELECT ON public.v_payroll_batches TO authenticated;
GRANT ALL    ON public.v_payroll_batches TO service_role;
