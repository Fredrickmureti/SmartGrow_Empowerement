-- =====================================================================
-- Security hardening pass (Sales/Finance/Payroll/POS diagnostics + triggers)
-- =====================================================================

-- 1) Restore security_invoker on the 8 views flagged ERROR by the linter.
--    These run RLS as the QUERYING user (not the view owner), closing a
--    cross-org data-leak risk on org-scoped diagnostic/reporting views.
--    The architecture already intends these to be invoker views
--    (see payroll-stage7-diagnostics.test.ts).
ALTER VIEW public.goods_receipt_lines_with_suspect_cost SET (security_invoker = on);
ALTER VIEW public.lot_quant_drift_view                  SET (security_invoker = on);
ALTER VIEW public.payroll_diagnostics                   SET (security_invoker = on);
ALTER VIEW public.payroll_mapping_findings              SET (security_invoker = on);
ALTER VIEW public.v_cost_layer_basis                    SET (security_invoker = on);
ALTER VIEW public.v_payroll_remittances_compat          SET (security_invoker = on);
ALTER VIEW public.v_pos_returnable_qty                  SET (security_invoker = on);
ALTER VIEW public.v_timesheet_payroll_ready             SET (security_invoker = on);

-- 2) Pin a deterministic search_path on every public function that lacks one.
--    Prevents search_path-injection / ambiguous resolution. Behavior is
--    unchanged because these functions reference public objects.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prokind = 'f'
      AND NOT EXISTS (
        SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) cfg
        WHERE cfg LIKE 'search_path=%'
      )
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = public', r.sig);
  END LOOP;
END $$;