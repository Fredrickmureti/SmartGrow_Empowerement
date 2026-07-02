-- Wave B1 Step 1 — print_policies.resolve RPC (ADR-0026)
-- Server-side policy resolution so PrintClient.print() can route automatically
-- without the operator picking a destination on every print.
--
-- Adapts the proposed ADR signature to the real `document_print_policies`
-- schema, which carries `printer_profile_id` (not device_id), no `copies`
-- column, and no `intent` column. `p_intent` is accepted for forward-compat
-- (when the table grows an intent column the function body changes only).
--
-- Fallback chain (most-specific wins):
--   1. (business_id, branch_id = p_branch_id, document_type)
--   2. (business_id, branch_id IS NULL, document_type)
--   3. no row → ask_user=true, render_mode='pdf', paper_format='a4'

CREATE OR REPLACE FUNCTION public.print_policies_resolve(
  p_business_id  uuid,
  p_branch_id    uuid,
  p_document_type text,
  p_intent       text DEFAULT NULL
)
RETURNS TABLE (
  printer_profile_id uuid,
  paper_format       text,
  render_mode        text,
  copies             integer,
  auto_print         boolean,
  ask_user           boolean
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH ranked AS (
    SELECT
      dpp.printer_profile_id,
      dpp.paper_format,
      dpp.render_mode,
      dpp.auto_print,
      CASE
        WHEN dpp.branch_id IS NOT DISTINCT FROM p_branch_id THEN 1
        WHEN dpp.branch_id IS NULL                          THEN 2
        ELSE 3
      END AS specificity
    FROM public.document_print_policies dpp
    WHERE dpp.business_id  = p_business_id
      AND dpp.document_type = p_document_type
      AND (dpp.branch_id IS NULL OR dpp.branch_id = p_branch_id)
  ),
  picked AS (
    SELECT * FROM ranked ORDER BY specificity ASC LIMIT 1
  )
  SELECT
    picked.printer_profile_id,
    COALESCE(picked.paper_format, 'a4')   AS paper_format,
    COALESCE(picked.render_mode, 'pdf')   AS render_mode,
    1                                     AS copies,
    COALESCE(picked.auto_print, false)    AS auto_print,
    (picked.printer_profile_id IS NULL
       OR COALESCE(picked.auto_print, false) = false) AS ask_user
  FROM picked
  UNION ALL
  SELECT NULL::uuid, 'a4', 'pdf', 1, false, true
  WHERE NOT EXISTS (SELECT 1 FROM picked)
  LIMIT 1;
$$;

COMMENT ON FUNCTION public.print_policies_resolve(uuid, uuid, text, text) IS
  'ADR-0026 Wave B1 Step 1. Resolves the effective print policy for (business, branch, document_type). Most-specific row wins (branch match > business-wide). Returns ask_user=true when no policy is configured or auto_print is off. p_intent is reserved for a future schema column.';

GRANT EXECUTE ON FUNCTION public.print_policies_resolve(uuid, uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.print_policies_resolve(uuid, uuid, text, text) TO service_role;
