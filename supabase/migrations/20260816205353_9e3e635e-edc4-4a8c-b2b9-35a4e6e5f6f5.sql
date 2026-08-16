-- Phase 3 completion: effective status is derived on the server, never in the browser.
-- Exposed as a PostgREST computed column: select=*,effective_status
CREATE OR REPLACE FUNCTION public.effective_status(public.supplier_item_terms)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN NOT COALESCE($1.is_active, false)                        THEN 'inactive'
    WHEN COALESCE($1.approval_status, 'approved') = 'rejected'    THEN 'rejected'
    WHEN COALESCE($1.approval_status, 'approved') = 'pending_approval' THEN 'pending_approval'
    WHEN COALESCE($1.approval_status, 'approved') = 'draft'       THEN 'draft'
    WHEN $1.effective_to IS NOT NULL AND $1.effective_to < CURRENT_DATE THEN 'expired'
    WHEN $1.effective_from IS NOT NULL AND $1.effective_from > CURRENT_DATE THEN 'scheduled'
    WHEN $1.effective_to IS NOT NULL
         AND $1.effective_to <= (CURRENT_DATE + INTERVAL '30 days')::date THEN 'expiring_soon'
    ELSE 'active'
  END
$$;

COMMENT ON FUNCTION public.effective_status(public.supplier_item_terms) IS
  'Server-derived effective status of a supplier condition (ADR 0142, Phase 3). The browser must not recompute validity windows.';

REVOKE ALL ON FUNCTION public.effective_status(public.supplier_item_terms) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.effective_status(public.supplier_item_terms) TO authenticated, service_role;

COMMENT ON COLUMN public.supplier_item_terms.lead_time_days IS
  'Calendar days from purchase-order issue to goods available at the receiving location (ADR 0141/0142).';