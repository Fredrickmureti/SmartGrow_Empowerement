
-- Wave B1 Step 2.5 — schema corrections + RPC v2 + command-queue backoff column
-- (1) document_print_policies: add `intent` and `copies` (ADR-0026 was promising both)
ALTER TABLE public.document_print_policies
  ADD COLUMN IF NOT EXISTS intent text NULL,
  ADD COLUMN IF NOT EXISTS copies int NOT NULL DEFAULT 1
    CHECK (copies BETWEEN 1 AND 20);

COMMENT ON COLUMN public.document_print_policies.intent IS
  'Optional print intent (receipt | a4_document | label | kitchen_ticket | packing_slip). NULL = applies to any intent for this document_type.';
COMMENT ON COLUMN public.document_print_policies.copies IS
  'Number of times the document is sent to the transport per print() call. 1..20.';

-- Helpful index for resolver: most-specific lookup
CREATE INDEX IF NOT EXISTS document_print_policies_resolve_idx
  ON public.document_print_policies (business_id, document_type, branch_id, intent);

-- (2) print_policies_resolve v2 — intent-aware, copies-aware, ask_user only when no row matched
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
      dpp.copies,
      CASE
        WHEN dpp.branch_id IS NOT DISTINCT FROM p_branch_id
             AND dpp.intent IS NOT DISTINCT FROM p_intent THEN 1
        WHEN dpp.branch_id IS NOT DISTINCT FROM p_branch_id
             AND dpp.intent IS NULL                       THEN 2
        WHEN dpp.branch_id IS NULL
             AND dpp.intent IS NOT DISTINCT FROM p_intent THEN 3
        WHEN dpp.branch_id IS NULL
             AND dpp.intent IS NULL                       THEN 4
        ELSE 99
      END AS specificity
    FROM public.document_print_policies dpp
    WHERE dpp.business_id   = p_business_id
      AND dpp.document_type = p_document_type
      AND (dpp.branch_id IS NULL OR dpp.branch_id = p_branch_id)
      AND (dpp.intent    IS NULL OR dpp.intent    = p_intent)
  ),
  picked AS (
    SELECT * FROM ranked WHERE specificity < 99 ORDER BY specificity ASC LIMIT 1
  )
  SELECT
    picked.printer_profile_id,
    COALESCE(picked.paper_format, 'a4')   AS paper_format,
    COALESCE(picked.render_mode, 'pdf')   AS render_mode,
    COALESCE(picked.copies, 1)            AS copies,
    COALESCE(picked.auto_print, false)    AS auto_print,
    false                                 AS ask_user
  FROM picked
  UNION ALL
  SELECT NULL::uuid, 'a4', 'pdf', 1, false, true
  WHERE NOT EXISTS (SELECT 1 FROM picked)
  LIMIT 1;
$$;

COMMENT ON FUNCTION public.print_policies_resolve(uuid, uuid, text, text) IS
  'ADR-0026 Wave B1 Step 2.5. Resolves the effective print policy for (business, branch, document_type, intent). Most-specific row wins: branch+intent > branch > business+intent > business. ask_user=true ONLY when no policy matched. auto_print is data, not a routing override.';

GRANT EXECUTE ON FUNCTION public.print_policies_resolve(uuid, uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.print_policies_resolve(uuid, uuid, text, text) TO service_role;

-- (3) hardware_command_queue: real backoff scheduling
ALTER TABLE public.hardware_command_queue
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NULL;

CREATE INDEX IF NOT EXISTS hardware_command_queue_pending_due_idx
  ON public.hardware_command_queue (status, next_attempt_at)
  WHERE status = 'pending';

COMMENT ON COLUMN public.hardware_command_queue.next_attempt_at IS
  'When the row becomes eligible to be picked again after a failure. NULL = immediately eligible. Set by CommandQueue.tick() using exponential backoff (1s, 2s, 4s, 8s, 30s).';
