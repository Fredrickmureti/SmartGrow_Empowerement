
CREATE TABLE IF NOT EXISTS public.legal_order_statutory_report_definitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NULL,
  jurisdiction_code TEXT NOT NULL,
  report_code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NULL,
  frequency TEXT NOT NULL DEFAULT 'monthly' CHECK (frequency IN ('daily','weekly','monthly','quarterly','annual','ad_hoc')),
  definition JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_statutory_defs_org
  ON public.legal_order_statutory_report_definitions (organization_id, jurisdiction_code, report_code)
  WHERE organization_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_statutory_defs_platform
  ON public.legal_order_statutory_report_definitions (jurisdiction_code, report_code)
  WHERE organization_id IS NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.legal_order_statutory_report_definitions TO authenticated;
GRANT ALL ON public.legal_order_statutory_report_definitions TO service_role;

ALTER TABLE public.legal_order_statutory_report_definitions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "statutory_defs_read"
  ON public.legal_order_statutory_report_definitions
  FOR SELECT TO authenticated
  USING (
    organization_id IS NULL
    OR public.is_org_member(auth.uid(), organization_id)
  );

CREATE POLICY "statutory_defs_write"
  ON public.legal_order_statutory_report_definitions
  FOR ALL TO authenticated
  USING (
    organization_id IS NOT NULL
    AND public.is_org_member(auth.uid(), organization_id)
    AND (
      public.has_org_role(auth.uid(), organization_id, 'owner'::app_role)
      OR public.has_org_role(auth.uid(), organization_id, 'admin'::app_role)
    )
  )
  WITH CHECK (
    organization_id IS NOT NULL
    AND public.is_org_member(auth.uid(), organization_id)
    AND (
      public.has_org_role(auth.uid(), organization_id, 'owner'::app_role)
      OR public.has_org_role(auth.uid(), organization_id, 'admin'::app_role)
    )
  );

CREATE TRIGGER trg_statutory_defs_updated_at
  BEFORE UPDATE ON public.legal_order_statutory_report_definitions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE INDEX IF NOT EXISTS idx_statutory_defs_juris_active
  ON public.legal_order_statutory_report_definitions (jurisdiction_code)
  WHERE is_active;

CREATE OR REPLACE VIEW public.v_legal_order_audit_timeline
WITH (security_invoker = true)
AS
SELECT
  e.organization_id, e.garnishment_id AS legal_order_id, e.effective_at AS occurred_at,
  'lifecycle_event'::text AS entry_kind, e.event AS action, e.actor_user_id,
  jsonb_build_object('from_status', e.from_status, 'to_status', e.to_status, 'reason_code', e.reason_code, 'reason_text', e.reason_text, 'evidence_document_url', e.evidence_document_url, 'payload', e.payload) AS details,
  e.id AS source_row_id, 'garnishment_lifecycle_events'::text AS source_table
FROM public.garnishment_lifecycle_events e
UNION ALL
SELECT a.organization_id, a.garnishment_id, a.changed_at, 'audit_log'::text, a.action, a.changed_by,
  jsonb_build_object('before', a.before_state, 'after', a.after_state, 'reason', a.reason),
  a.id, 'garnishment_audit_log'::text
FROM public.garnishment_audit_log a
UNION ALL
SELECT d.organization_id, e.garnishment_id, d.dispatched_at, 'notification'::text, d.topic, NULL::uuid,
  jsonb_build_object('topic', d.topic, 'notified_users', d.notified_users, 'source_event_id', d.source_event_id),
  d.source_event_id, 'legal_order_event_dispatch_log'::text
FROM public.legal_order_event_dispatch_log d
JOIN public.garnishment_lifecycle_events e ON e.id = d.source_event_id
UNION ALL
SELECT bl.organization_id, bl.garnishment_id, b.created_at, 'remittance_batch'::text, 'batch_created'::text, b.created_by,
  jsonb_build_object('batch_id', b.id, 'batch_number', b.batch_number, 'recipient_id', b.recipient_id, 'planned_amount', bl.planned_amount),
  b.id, 'legal_order_remittance_batches'::text
FROM public.legal_order_remittance_batches b
JOIN public.legal_order_remittance_batch_lines bl ON bl.batch_id = b.id
UNION ALL
SELECT bl.organization_id, bl.garnishment_id, b.settled_at, 'remittance_batch'::text, 'batch_settled'::text, NULL::uuid,
  jsonb_build_object('batch_id', b.id, 'batch_number', b.batch_number, 'recipient_id', b.recipient_id, 'actual_amount', bl.actual_amount, 'settled_reference', b.settled_reference, 'settled_payment_date', b.settled_payment_date),
  b.id, 'legal_order_remittance_batches'::text
FROM public.legal_order_remittance_batches b
JOIN public.legal_order_remittance_batch_lines bl ON bl.batch_id = b.id
WHERE b.settled_at IS NOT NULL
UNION ALL
SELECT bl.organization_id, bl.garnishment_id, b.cancelled_at, 'remittance_batch'::text, 'batch_cancelled'::text, NULL::uuid,
  jsonb_build_object('batch_id', b.id, 'batch_number', b.batch_number, 'cancelled_reason', b.cancelled_reason),
  b.id, 'legal_order_remittance_batches'::text
FROM public.legal_order_remittance_batches b
JOIN public.legal_order_remittance_batch_lines bl ON bl.batch_id = b.id
WHERE b.cancelled_at IS NOT NULL;

GRANT SELECT ON public.v_legal_order_audit_timeline TO authenticated;

COMMENT ON VIEW public.v_legal_order_audit_timeline IS
  'Phase 8: unified time-ordered audit trail per legal order. security_invoker=true.';

CREATE OR REPLACE FUNCTION public.legal_order_running_balance(
  _organization_id UUID,
  _legal_order_id  UUID,
  _as_of           DATE DEFAULT CURRENT_DATE
)
RETURNS TABLE (
  legal_order_id UUID, as_of DATE, total_owed NUMERIC, accrued NUMERIC,
  remitted NUMERIC, outstanding NUMERIC,
  last_accrual_at TIMESTAMPTZ, last_remittance_at TIMESTAMPTZ
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT public.is_org_member(auth.uid(), _organization_id) THEN
    RAISE EXCEPTION 'access denied to organization %', _organization_id USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH ord AS (
    SELECT lo.id, lo.total_owed FROM public.legal_orders lo
    WHERE lo.id = _legal_order_id AND lo.organization_id = _organization_id
  ),
  accr AS (
    SELECT COALESCE(SUM(gl.amount),0)::numeric AS accrued, MAX(gl.created_at) AS last_accrual_at
    FROM public.garnishment_ledger gl
    WHERE gl.garnishment_id = _legal_order_id AND gl.organization_id = _organization_id
      AND gl.payment_date <= _as_of
  ),
  rem AS (
    SELECT COALESCE(SUM(bl.actual_amount),0)::numeric AS remitted, MAX(b.settled_at) AS last_remittance_at
    FROM public.legal_order_remittance_batch_lines bl
    JOIN public.legal_order_remittance_batches b ON b.id = bl.batch_id
    WHERE bl.garnishment_id = _legal_order_id AND bl.organization_id = _organization_id
      AND b.settled_at IS NOT NULL AND b.settled_payment_date <= _as_of
  )
  SELECT ord.id, _as_of, ord.total_owed, accr.accrued, rem.remitted,
         GREATEST(COALESCE(ord.total_owed, accr.accrued) - rem.remitted, 0)::numeric,
         accr.last_accrual_at, rem.last_remittance_at
  FROM ord, accr, rem;
END;
$$;

REVOKE ALL ON FUNCTION public.legal_order_running_balance(UUID, UUID, DATE) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.legal_order_running_balance(UUID, UUID, DATE) TO authenticated;

COMMENT ON FUNCTION public.legal_order_running_balance(UUID, UUID, DATE) IS
  'Phase 8: point-in-time accrued/remitted/outstanding balance for a legal order.';
