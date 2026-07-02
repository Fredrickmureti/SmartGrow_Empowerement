CREATE OR REPLACE VIEW public.accounting_integrity_findings_stock_adjustments
WITH (security_invoker = true) AS
SELECT
  gen_random_uuid()                                           AS id,
  sa.organization_id                                          AS organization_id,
  sa.business_id                                              AS business_id,
  sa.branch_id                                                AS branch_id,
  'critical'::text                                            AS severity,
  'stock_adjustment_missing_journal_entry'::text              AS finding_code,
  'Approved stock adjustment has no posted journal entry'::text AS finding_title,
  format(
    'Stock adjustment %s (approved %s, reason=%s) moved inventory but has no linked posted journal entry. The inventory subledger and GL are out of sync. Remediate from Finance → Inventory reconciliation.',
    sa.adjustment_number,
    COALESCE(sa.approved_at::date::text, sa.adjustment_date::text),
    sa.reason
  )                                                           AS finding_detail,
  'stock_adjustment'::text                                    AS entity_type,
  sa.id                                                       AS entity_id,
  sa.adjustment_number                                        AS entity_ref,
  jsonb_build_object(
    'adjustment_date', sa.adjustment_date,
    'approved_at',     sa.approved_at,
    'reason',          sa.reason,
    'warehouse_id',    sa.warehouse_id,
    'reverses_adjustment_id', sa.reverses_adjustment_id
  )                                                           AS evidence,
  COALESCE(sa.approved_at, now())                             AS detected_at
FROM public.stock_adjustments sa
WHERE sa.status = 'approved'
  AND NOT EXISTS (
    SELECT 1
      FROM public.journal_entries je
     WHERE je.source_type = 'stock_adjustment'
       AND je.source_id   = sa.id
  );

GRANT SELECT ON public.accounting_integrity_findings_stock_adjustments TO authenticated;

COMMENT ON VIEW public.accounting_integrity_findings_stock_adjustments IS
  'ADR 0016 — surfaces approved stock adjustments with no posted JE as critical accounting integrity findings.';

CREATE OR REPLACE FUNCTION public.get_accounting_integrity_findings(
  _include_supplemental boolean DEFAULT true
)
RETURNS TABLE(
  id              uuid,
  organization_id uuid,
  business_id     uuid,
  branch_id       uuid,
  severity        text,
  finding_code    text,
  finding_title   text,
  finding_detail  text,
  entity_type     text,
  entity_id       uuid,
  entity_ref      text,
  evidence        jsonb,
  detected_at     timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT * FROM public.accounting_integrity_findings
  UNION ALL
  SELECT * FROM public.accounting_integrity_findings_supplemental
    WHERE _include_supplemental
  UNION ALL
  SELECT * FROM public.accounting_integrity_findings_stock_adjustments
    WHERE _include_supplemental;
$$;

REVOKE ALL    ON FUNCTION public.get_accounting_integrity_findings(boolean) FROM public;
GRANT EXECUTE ON FUNCTION public.get_accounting_integrity_findings(boolean) TO authenticated;