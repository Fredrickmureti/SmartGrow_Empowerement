-- Legal Orders → Payroll: draft-run invalidation on lifecycle events
--
-- When garnishment_transition emits a legal_order.* event onto
-- business_event_outbox (activated / suspended / resumed / released /
-- expired / mark_satisfied / terminate_unsatisfied), any DRAFT or
-- PENDING_APPROVAL payroll run that would include that order must be
-- flagged for recompute so the payslip reflects the change.
--
-- POSTED / APPROVED / PAID / REVERSED runs are immutable; those we
-- notify via audit_logs so finance can decide whether to file a
-- correction run.

-- 1. Marker column on payroll_runs.
ALTER TABLE public.payroll_runs
  ADD COLUMN IF NOT EXISTS needs_recompute_reason text;

COMMENT ON COLUMN public.payroll_runs.needs_recompute_reason IS
  'Set when a downstream event (e.g. legal_order.activated) invalidates the compute snapshot for a draft/pending_approval run. UI prompts the user to recompute before approval. Cleared on next successful compute.';

-- 2. Trigger function: react to legal_order.* outbox emissions.
CREATE OR REPLACE FUNCTION public.tg_business_event_outbox_react_legal_order()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_action text;
  v_order  public.legal_orders_records;
  v_reason text;
  v_updated_draft int;
BEGIN
  IF NEW.event_type IS NULL OR NEW.event_type NOT LIKE 'legal_order.%' THEN
    RETURN NEW;
  END IF;

  v_action := split_part(NEW.event_type, '.', 2);
  -- Payment posted is a downstream settlement event; it does not invalidate
  -- computed payslips. Only lifecycle events do.
  IF v_action IN ('payment_posted') THEN
    RETURN NEW;
  END IF;

  -- Resolve the order. source_doc_id on the outbox row IS the order id
  -- (garnishment_transition emits it that way).
  SELECT * INTO v_order
    FROM public.legal_orders_records
   WHERE id = NEW.source_doc_id;
  IF v_order.id IS NULL THEN
    RETURN NEW;
  END IF;

  v_reason := 'legal_order_' || v_action || '_' || v_order.id::text;

  -- (a) Stamp reworkable runs so the UI shows "recompute required".
  WITH touched AS (
    UPDATE public.payroll_runs pr
       SET needs_recompute_reason = v_reason,
           updated_at = now()
     WHERE pr.organization_id = v_order.organization_id
       AND (v_order.business_id IS NULL OR pr.business_id = v_order.business_id)
       AND pr.status IN ('draft','pending_approval')
       AND pr.pay_period_end   >= v_order.start_date
       AND (v_order.end_date IS NULL OR pr.pay_period_start <= v_order.end_date)
       AND EXISTS (
         SELECT 1 FROM public.payslips p
          WHERE p.payroll_run_id = pr.id
            AND p.employee_id    = v_order.employee_id
       )
    RETURNING pr.id
  )
  SELECT count(*) INTO v_updated_draft FROM touched;

  -- (b) For runs already through approval, log a warning. We deliberately
  -- do NOT mutate posted/paid/reversed runs — that would violate
  -- payroll_runs_immutability_guard and the maker-checker invariants.
  INSERT INTO public.audit_logs (
    organization_id, business_id, user_id, action, entity_type, entity_id,
    entity_name, new_values, changes_summary
  )
  SELECT pr.organization_id,
         pr.business_id,
         NEW.actor_user_id,
         'payroll.legal_order.affects_finalized_run',
         'payroll_run',
         pr.id,
         pr.payroll_number,
         jsonb_build_object(
           'legal_order_id',      v_order.id,
           'legal_order_action',  v_action,
           'legal_order_kind',    v_order.kind,
           'employee_id',         v_order.employee_id,
           'run_status',          pr.status,
           'pay_period_start',    pr.pay_period_start,
           'pay_period_end',      pr.pay_period_end
         ),
         format(
           'Legal order %s was %s outside this run; file a correction run if the change should apply to this period.',
           v_order.id, v_action
         )
    FROM public.payroll_runs pr
   WHERE pr.organization_id = v_order.organization_id
     AND (v_order.business_id IS NULL OR pr.business_id = v_order.business_id)
     AND pr.status IN ('approved','posted','paid','reversed')
     AND pr.pay_period_end   >= v_order.start_date
     AND (v_order.end_date IS NULL OR pr.pay_period_start <= v_order.end_date)
     AND EXISTS (
       SELECT 1 FROM public.payslips p
        WHERE p.payroll_run_id = pr.id
          AND p.employee_id    = v_order.employee_id
     );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Never break the outbox writer. Downstream reactor errors are
  -- diagnostic — the event itself is already durably enqueued.
  RAISE WARNING '[tg_business_event_outbox_react_legal_order] % (%): %',
    SQLERRM, SQLSTATE, NEW.event_type;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_business_event_outbox_react_legal_order
  ON public.business_event_outbox;

CREATE TRIGGER trg_business_event_outbox_react_legal_order
  AFTER INSERT ON public.business_event_outbox
  FOR EACH ROW
  WHEN (NEW.event_type LIKE 'legal_order.%')
  EXECUTE FUNCTION public.tg_business_event_outbox_react_legal_order();

-- 3. Clear the recompute marker on successful compute. compute-payroll
-- writes payroll_runs.run_type_policy_snapshot at the end of every run;
-- reuse that write path via a BEFORE UPDATE hook so any compute (retry,
-- reactor-triggered, or user-initiated) clears the flag.
CREATE OR REPLACE FUNCTION public.tg_payroll_runs_clear_recompute_marker()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.run_type_policy_snapshot IS DISTINCT FROM OLD.run_type_policy_snapshot
     AND NEW.run_type_policy_snapshot IS NOT NULL THEN
    NEW.needs_recompute_reason := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_payroll_runs_clear_recompute_marker
  ON public.payroll_runs;

CREATE TRIGGER trg_payroll_runs_clear_recompute_marker
  BEFORE UPDATE ON public.payroll_runs
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_payroll_runs_clear_recompute_marker();

-- 4. Stamp the current stuck run so the UI signals recompute is required.
-- The user's active legal order (child_support, 7000) was activated at
-- 10:47:14, one minute before the run was created at 10:48:23. compute
-- silently dropped it because of the swallowed error path fixed in this
-- pass. Flag the run so the recompute banner appears.
UPDATE public.payroll_runs
   SET needs_recompute_reason = 'legal_order_backfill_' ||
                                '0dfb6e04-b7bd-4e40-9507-ec56fb370f7f'
 WHERE id = '5b3ffca3-90db-41d1-866f-340e9eb1f43f'
   AND status = 'draft'
   AND needs_recompute_reason IS NULL;