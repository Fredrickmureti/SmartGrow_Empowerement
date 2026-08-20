-- ─────────────────────────────────────────────────────────────
-- Phase 1: AR/AP reporting authorization hardening
--
-- Every AR/AP reporting RPC must verify organisation membership
-- before using the caller-supplied _org_id. `get_ar_ap_aging_from_ledger`,
-- `get_ap_summary` and `finance_ap_open_items_as_of` already do; the two
-- functions below did not.
-- ─────────────────────────────────────────────────────────────

-- 1. get_control_account_reconciliation ------------------------
-- SECURITY DEFINER with no membership check. Inject the standard gate
-- immediately after the body's BEGIN, preserving the rest of the body
-- verbatim (it is long and unrelated to this change).
DO $mig$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid)
    INTO v_def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'get_control_account_reconciliation';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'get_control_account_reconciliation not found';
  END IF;

  IF position('finance_can_read_org' in v_def) > 0 THEN
    RAISE NOTICE 'get_control_account_reconciliation already gated; skipping';
    RETURN;
  END IF;

  -- first occurrence only (regexp_replace without the 'g' flag)
  v_def := regexp_replace(
    v_def,
    E'\nBEGIN\n',
    E'\nBEGIN\n  IF NOT public.finance_can_read_org(_org_id) THEN\n    RAISE EXCEPTION ''Not authorized for this organization'' USING ERRCODE = ''42501'';\n  END IF;\n'
  );

  IF position('finance_can_read_org' in v_def) = 0 THEN
    RAISE EXCEPTION 'Failed to inject authorization gate into get_control_account_reconciliation';
  END IF;

  EXECUTE v_def;
END
$mig$;

REVOKE ALL ON FUNCTION public.get_control_account_reconciliation(uuid, uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_control_account_reconciliation(uuid, uuid, text, uuid) TO authenticated, service_role;

-- 2. get_ar_summary -------------------------------------------
-- Was plain STABLE SQL (invoker rights) with no membership check, granted
-- to anon. Restated as gated SECURITY DEFINER plpgsql, mirroring its AP
-- twin `get_ap_summary`. The query body is unchanged.
CREATE OR REPLACE FUNCTION public.get_ar_summary(
  _org_id uuid,
  _business_id uuid DEFAULT NULL::uuid,
  _branch_id uuid DEFAULT NULL::uuid,
  _as_of date DEFAULT CURRENT_DATE
)
RETURNS TABLE(
  open_document_count integer,
  total_residual numeric,
  not_due numeric,
  current_bucket numeric,
  days30 numeric,
  days60 numeric,
  days90 numeric,
  overdue_count integer,
  unposted_document_count integer,
  unposted_amount numeric
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.finance_can_read_org(_org_id) THEN
    RAISE EXCEPTION 'Not authorized for this organization' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH open_items AS (
    SELECT o.*, public.finance_aging_bucket(o.due_date, _as_of) AS bucket
      FROM public.finance_ar_open_items o
     WHERE o.organization_id = _org_id
       AND (_business_id IS NULL OR o.business_id = _business_id)
       AND (_branch_id IS NULL OR o.branch_id = _branch_id)
       AND o.document_date <= _as_of
       AND o.residual_amount > 0.01
  ),
  credits AS (
    SELECT COALESCE(SUM(cc.base_credit_amount), 0) AS amt
      FROM public.finance_ar_customer_credit cc
     WHERE cc.organization_id = _org_id
       AND (_business_id IS NULL OR cc.business_id = _business_id)
  ),
  unposted AS (
    SELECT COUNT(*)::int AS cnt,
           COALESCE(SUM(GREATEST(0, COALESCE(i.total,0) - COALESCE(i.amount_paid,0))), 0) AS amt
      FROM public.invoices i
     WHERE i.organization_id = _org_id
       AND (_business_id IS NULL OR i.business_id = _business_id)
       AND (_branch_id IS NULL OR i.branch_id = _branch_id)
       AND i.status NOT IN ('draft', 'cancelled', 'voided', 'paid')
       AND NOT EXISTS (
         SELECT 1 FROM public.journal_entries je
          WHERE je.source_type = 'invoice'
            AND je.source_id = i.id
            AND je.status = 'posted'
       )
  )
  SELECT
    (SELECT COUNT(*)::int FROM open_items),
    (SELECT COALESCE(SUM(base_residual_amount), 0) FROM open_items) - (SELECT amt FROM credits),
    (SELECT COALESCE(SUM(base_residual_amount), 0) FROM open_items WHERE bucket = 'not_due'),
    (SELECT COALESCE(SUM(base_residual_amount), 0) FROM open_items WHERE bucket = 'current') - (SELECT amt FROM credits),
    (SELECT COALESCE(SUM(base_residual_amount), 0) FROM open_items WHERE bucket = 'days30'),
    (SELECT COALESCE(SUM(base_residual_amount), 0) FROM open_items WHERE bucket = 'days60'),
    (SELECT COALESCE(SUM(base_residual_amount), 0) FROM open_items WHERE bucket = 'days90'),
    (SELECT COUNT(*)::int FROM open_items WHERE bucket <> 'not_due'),
    (SELECT cnt FROM unposted),
    (SELECT amt FROM unposted);
END
$function$;

REVOKE ALL ON FUNCTION public.get_ar_summary(uuid, uuid, uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_ar_summary(uuid, uuid, uuid, date) TO authenticated, service_role;