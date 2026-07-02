
-- ============================================================================
-- Slice D — Approval workflow + reconciliation gate on return runs
-- ============================================================================

ALTER TABLE public.payroll_return_runs
  ADD COLUMN IF NOT EXISTS approver_id uuid,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS reconciliation_status text NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS reconciliation_breach jsonb,
  ADD COLUMN IF NOT EXISTS reconciliation_override_reason text,
  ADD COLUMN IF NOT EXISTS reconciliation_override_by uuid,
  ADD COLUMN IF NOT EXISTS reconciliation_override_at timestamptz;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='payroll_return_runs_reconciliation_status_check'
  ) THEN
    ALTER TABLE public.payroll_return_runs
      ADD CONSTRAINT payroll_return_runs_reconciliation_status_check
      CHECK (reconciliation_status IN ('unknown','ok','breach','overridden','not_applicable'));
  END IF;
END $$;

-- Extend state machine: add pending_approval transitions
CREATE OR REPLACE FUNCTION public.payroll_return_assert_transition(p_from text, p_to text)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  IF (p_from, p_to) NOT IN (
    ('draft','generated'),
    ('generated','pending_approval'),
    ('generated','submitted_awaiting_ack'),
    ('generated','filed'),
    ('generated','superseded'),
    ('pending_approval','submitted_awaiting_ack'),
    ('pending_approval','filed'),
    ('pending_approval','generated'),
    ('pending_approval','superseded'),
    ('submitted_awaiting_ack','acknowledged'),
    ('submitted_awaiting_ack','rejected'),
    ('submitted_awaiting_ack','filed'),
    ('acknowledged','filed'),
    ('rejected','generated'),
    ('rejected','submitted_awaiting_ack'),
    ('filed','superseded'),
    ('acknowledged','superseded'),
    ('rejected','superseded')
  ) THEN
    RAISE EXCEPTION 'invalid return state transition: % -> %', p_from, p_to
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

-- ============================================================================
-- Return-level diagnostics table (blocking gate for submission)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.payroll_return_diagnostics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.payroll_return_runs(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  code text NOT NULL,
  severity text NOT NULL DEFAULT 'blocker' CHECK (severity IN ('info','warning','blocker')),
  blocking boolean NOT NULL DEFAULT true,
  message text NOT NULL,
  details jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid,
  resolution_note text,
  UNIQUE (run_id, code)
);

CREATE INDEX IF NOT EXISTS idx_payroll_return_diagnostics_run ON public.payroll_return_diagnostics(run_id);
CREATE INDEX IF NOT EXISTS idx_payroll_return_diagnostics_open ON public.payroll_return_diagnostics(run_id) WHERE resolved_at IS NULL;

GRANT SELECT ON public.payroll_return_diagnostics TO authenticated;
GRANT ALL ON public.payroll_return_diagnostics TO service_role;

ALTER TABLE public.payroll_return_diagnostics ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "return_diagnostics_org_read" ON public.payroll_return_diagnostics;
CREATE POLICY "return_diagnostics_org_read"
  ON public.payroll_return_diagnostics
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_business_access uba
      WHERE uba.user_id = auth.uid()
        AND uba.business_id = payroll_return_diagnostics.business_id
    )
  );

-- ============================================================================
-- Reconciliation/SoD enforcement trigger on transitions
-- ============================================================================

CREATE OR REPLACE FUNCTION public.payroll_return_gate_submission()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_template_requires_approval boolean;
  v_blocking_count integer;
BEGIN
  -- Only inspect terminal-bound transitions
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  -- Block submission while reconciliation is breached
  IF NEW.status IN ('submitted_awaiting_ack','filed')
     AND NEW.reconciliation_status = 'breach' THEN
    RAISE EXCEPTION 'RECONCILIATION_BREACH: return % cannot be submitted while reconciliation is breached; override or regenerate first', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;

  -- Block submission while unresolved blocking diagnostics exist
  IF NEW.status IN ('submitted_awaiting_ack','filed') THEN
    SELECT COUNT(*) INTO v_blocking_count
      FROM public.payroll_return_diagnostics d
      WHERE d.run_id = NEW.id
        AND d.blocking = true
        AND d.resolved_at IS NULL;
    IF v_blocking_count > 0 THEN
      RAISE EXCEPTION 'BLOCKING_DIAGNOSTICS: % unresolved blocking diagnostic(s) on return %; resolve before submitting',
        v_blocking_count, NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- SoD: approver must differ from preparer when leaving pending_approval
  IF OLD.status = 'pending_approval'
     AND NEW.status IN ('submitted_awaiting_ack','filed') THEN
    IF NEW.approver_id IS NULL THEN
      RAISE EXCEPTION 'APPROVER_REQUIRED: pending_approval -> % requires approver_id', NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.approver_id = COALESCE(NEW.submitted_by, NEW.generated_by) THEN
      RAISE EXCEPTION 'SOD_VIOLATION: approver_id must differ from preparer (generated_by/submitted_by)'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- If pack template declares approval_required, enforce pending_approval gate
  IF NEW.status = 'submitted_awaiting_ack' AND OLD.status = 'generated' THEN
    SELECT t.approval_required INTO v_template_requires_approval
      FROM public.localization_pack_return_templates t
      WHERE t.code = NEW.template_code
        AND (t.pack_id = NEW.template_pack_id OR (t.pack_id IS NULL AND NEW.template_pack_id IS NULL))
      LIMIT 1;
    IF COALESCE(v_template_requires_approval, false) THEN
      RAISE EXCEPTION 'APPROVAL_REQUIRED: template % requires approval; must transition via pending_approval', NEW.template_code
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_payroll_return_gate_submission ON public.payroll_return_runs;
CREATE TRIGGER trg_payroll_return_gate_submission
  BEFORE UPDATE ON public.payroll_return_runs
  FOR EACH ROW EXECUTE FUNCTION public.payroll_return_gate_submission();

-- ============================================================================
-- Slice E — Bank clearance for remittance payments
-- ============================================================================

ALTER TABLE public.payroll_remittance_payments
  ADD COLUMN IF NOT EXISTS bank_cleared_at timestamptz,
  ADD COLUMN IF NOT EXISTS bank_cleared_transaction_id uuid,
  ADD COLUMN IF NOT EXISTS bank_cleared_by uuid,
  ADD COLUMN IF NOT EXISTS bank_match_confidence numeric;

CREATE INDEX IF NOT EXISTS idx_remit_payments_uncleared
  ON public.payroll_remittance_payments(business_id, bank_account_id)
  WHERE bank_cleared_at IS NULL AND status='posted';

-- Auto-match imported bank transactions to remittance payments.
-- Strict match: same bank_account_id, same amount (negative outflow),
-- transaction_date within ±5 days of payment_date, AND reference_number match
-- (substring either way) when present.
CREATE OR REPLACE FUNCTION public.payroll_match_bank_remittance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_payment RECORD;
BEGIN
  IF NEW.amount IS NULL OR NEW.bank_account_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Bank outflows for remittances appear as negative on the statement
  SELECT p.*
    INTO v_payment
    FROM public.payroll_remittance_payments p
   WHERE p.bank_account_id = NEW.bank_account_id
     AND p.status = 'posted'
     AND p.bank_cleared_at IS NULL
     AND ABS(ABS(NEW.amount) - p.total_amount) < 0.01
     AND NEW.transaction_date BETWEEN (p.payment_date - INTERVAL '5 days')::date
                                  AND (p.payment_date + INTERVAL '5 days')::date
     AND (
       p.reference_number IS NULL
       OR NEW.reference IS NULL
       OR NEW.reference ILIKE '%' || p.reference_number || '%'
       OR p.reference_number ILIKE '%' || COALESCE(NEW.reference,'') || '%'
       OR NEW.description ILIKE '%' || p.reference_number || '%'
     )
   ORDER BY ABS(NEW.transaction_date - p.payment_date) ASC
   LIMIT 1;

  IF v_payment.id IS NOT NULL THEN
    UPDATE public.payroll_remittance_payments
       SET bank_cleared_at = COALESCE(bank_cleared_at, now()),
           bank_cleared_transaction_id = NEW.id,
           bank_match_confidence = CASE WHEN v_payment.reference_number IS NOT NULL
                                          AND (NEW.reference ILIKE '%'||v_payment.reference_number||'%'
                                            OR NEW.description ILIKE '%'||v_payment.reference_number||'%')
                                        THEN 1.0 ELSE 0.75 END
     WHERE id = v_payment.id
       AND bank_cleared_at IS NULL;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_payroll_match_bank_remittance ON public.bank_transactions;
CREATE TRIGGER trg_payroll_match_bank_remittance
  AFTER INSERT OR UPDATE OF amount, reference, description, transaction_date
  ON public.bank_transactions
  FOR EACH ROW EXECUTE FUNCTION public.payroll_match_bank_remittance();

-- ============================================================================
-- Slice F — Filing calendar v2 (overrides + pending upgrades + approval flags)
-- ============================================================================

DROP VIEW IF EXISTS public.payroll_filing_calendar CASCADE;

CREATE VIEW public.payroll_filing_calendar AS
WITH installed AS (
  SELECT ilp.organization_id, ilp.business_id, ilp.pack_id
    FROM public.installed_localization_packs ilp
   WHERE ilp.status = 'installed'
),
pending_upgrades AS (
  SELECT DISTINCT organization_id, business_id, pack_id
    FROM public.pack_upgrade_proposals
   WHERE status = 'pending'
),
candidate_templates AS (
  SELECT t.code, t.display_name, t.period, t.due_day, t.due_month_offset,
         t.authority_name, t.output, t.approval_required,
         i.organization_id, i.business_id, t.pack_id, t.updated_at AS template_updated_at
    FROM public.localization_pack_return_templates t
    JOIN installed i ON i.pack_id = t.pack_id
  UNION ALL
  SELECT t.code, t.display_name, t.period, t.due_day, t.due_month_offset,
         t.authority_name, t.output, t.approval_required,
         i.organization_id, i.business_id, NULL::uuid, t.updated_at
    FROM public.localization_pack_return_templates t
    CROSS JOIN installed i
   WHERE t.pack_id IS NULL
),
merged AS (
  SELECT ct.organization_id, ct.business_id, ct.pack_id,
         ct.code, ct.display_name, ct.period,
         COALESCE(o.due_day, ct.due_day) AS due_day,
         COALESCE(o.due_month_offset, ct.due_month_offset) AS due_month_offset,
         ct.authority_name,
         COALESCE(o.output, ct.output) AS output,
         ct.approval_required,
         (o.id IS NOT NULL) AS is_overridden,
         (o.base_template_updated_at IS NOT NULL
            AND o.base_template_updated_at <> ct.template_updated_at) AS override_stale,
         (pu.pack_id IS NOT NULL) AS upgrade_pending
    FROM candidate_templates ct
    LEFT JOIN public.payroll_return_template_overrides o
      ON o.business_id = ct.business_id AND o.template_code = ct.code
    LEFT JOIN pending_upgrades pu
      ON pu.organization_id = ct.organization_id
     AND pu.business_id = ct.business_id
     AND pu.pack_id = ct.pack_id
),
periods AS (
  SELECT m.*,
         CASE m.period
           WHEN 'monthly'   THEN (date_trunc('month', now() - interval '1 mon'))::date
           WHEN 'quarterly' THEN (date_trunc('quarter', now() - interval '3 mons'))::date
           WHEN 'annual'    THEN (date_trunc('year', now() - interval '1 year'))::date
           ELSE (date_trunc('month', now()))::date
         END AS period_start,
         CASE m.period
           WHEN 'monthly'   THEN (date_trunc('month', now()) - interval '1 day')::date
           WHEN 'quarterly' THEN (date_trunc('quarter', now()) - interval '1 day')::date
           WHEN 'annual'    THEN (date_trunc('year', now()) - interval '1 day')::date
           ELSE (date_trunc('month', now()) + interval '1 mon' - interval '1 day')::date
         END AS period_end
    FROM merged m
)
SELECT p.organization_id, p.business_id, p.pack_id,
       p.code AS template_code, p.display_name, p.period,
       p.authority_name, p.output, p.approval_required,
       p.is_overridden, p.override_stale, p.upgrade_pending,
       p.period_start, p.period_end,
       (p.period_end
         + ((COALESCE(p.due_month_offset, 1) || ' months')::interval)
         - interval '1 day'
         + (((COALESCE(p.due_day, 28) - 28) || ' days')::interval)
       )::date AS due_date,
       r.id AS latest_run_id,
       r.status AS latest_run_status,
       r.reconciliation_status,
       r.approver_id,
       r.approved_at,
       r.filed_at, r.submitted_at,
       CASE
         WHEN r.id IS NULL THEN 'not_started'
         WHEN r.status IN ('filed','acknowledged') THEN 'filed'
         WHEN r.status = 'rejected' THEN 'rejected'
         WHEN r.status = 'submitted_awaiting_ack' THEN 'awaiting_ack'
         WHEN r.status = 'pending_approval' THEN 'pending_approval'
         WHEN r.status = 'generated' THEN 'generated'
         ELSE 'draft'
       END AS state,
       CASE
         WHEN r.status IN ('filed','acknowledged') THEN false
         WHEN (p.period_end + ((COALESCE(p.due_month_offset, 1) || ' months')::interval)
               - interval '1 day'
               + (((COALESCE(p.due_day, 28) - 28) || ' days')::interval))::date < CURRENT_DATE THEN true
         ELSE false
       END AS is_overdue
  FROM periods p
  LEFT JOIN LATERAL (
    SELECT rr.id, rr.status, rr.filed_at, rr.submitted_at,
           rr.reconciliation_status, rr.approver_id, rr.approved_at
      FROM public.payroll_return_runs rr
     WHERE rr.organization_id = p.organization_id
       AND rr.business_id = p.business_id
       AND rr.template_code = p.code
       AND rr.period_start = p.period_start
       AND rr.period_end = p.period_end
       AND rr.status <> 'superseded'
     ORDER BY rr.created_at DESC
     LIMIT 1
  ) r ON true;

GRANT SELECT ON public.payroll_filing_calendar TO authenticated;
