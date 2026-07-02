-- Fix 1: Remove duplicate post_journal_entry_atomic to resolve PostgREST overload ambiguity
DROP FUNCTION IF EXISTS public.post_journal_entry_atomic(uuid, uuid, text, date, text, text, text, text, uuid, boolean, boolean, jsonb);

-- Fix 2: Repair the two confirmed invoices that lost their JE due to the silent failure.
-- They will be reposted by the application on next confirm action; we revert them to draft so
-- the user can re-confirm cleanly.
UPDATE public.invoices
SET status = 'draft', confirmed_by = NULL, journal_entry_id = NULL
WHERE organization_id = '0a1691f2-1d76-430d-809c-68955e560ec7'
  AND journal_entry_id IS NULL
  AND status IN ('confirmed', 'sent');