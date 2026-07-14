-- Repair Sales/POS transaction pipeline after inventory replenishment work.
-- Root cause: PostgREST schema cache went out of sync with the live catalog
-- after the burst of Jul 12–14 inventory migrations (reset_module__inventory,
-- procurement recommendations, approval-mirror trigger, attach_recommendation_to_po,
-- cancel_procurement_approval). Symptoms:
--   * POST /rest/v1/rpc/process_pos_transaction → 404 (cache missing the RPC)
--   * POST /rest/v1/invoices → 400 (cache column list stale)
-- Neither the RPC body nor the invoices schema changed, so recreating them
-- would introduce drift. The correct fix is to force the API layer to
-- re-introspect and to remove one latent duplicate trigger that surfaced
-- during the audit.

-- 1) Idempotent defensive grants on the shared Sales/POS transaction pipeline.
--    These are already present in the DB; re-issuing them survives any future
--    CREATE OR REPLACE that inadvertently strips privileges.
GRANT EXECUTE ON FUNCTION public.process_pos_transaction(
  uuid, uuid, uuid, uuid, jsonb, jsonb,
  numeric, numeric, numeric, numeric,
  text, uuid, text, text, text,
  uuid, uuid, uuid, numeric, uuid, text
) TO authenticated;

GRANT EXECUTE ON FUNCTION public.get_next_invoice_number(uuid, uuid) TO authenticated;

-- 2) Remove the duplicate AFTER-INSERT trigger on public.invoices. Both
--    `trg_notify_invoice_created` and `trigger_notify_invoice_created`
--    execute the same `notify_invoice_created()` body, so every invoice
--    fanned out two notifications to every org member. Keep the shorter
--    canonical name; drop the legacy alias.
DROP TRIGGER IF EXISTS trigger_notify_invoice_created ON public.invoices;

-- 3) Force PostgREST to reload its schema cache so both the RPC and the
--    invoices column list become visible to the Data API again. This is
--    the actual fix for the 404 / 400 pair.
NOTIFY pgrst, 'reload schema';