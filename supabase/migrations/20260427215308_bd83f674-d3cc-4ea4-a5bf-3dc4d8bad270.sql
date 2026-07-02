-- Fix POS shift close 27000 error: BEFORE-trigger same-row re-update collision.
-- Move GL posting trigger from BEFORE UPDATE to AFTER UPDATE so that
-- post_pos_shift_gl()'s own UPDATE pos_shifts SET journal_entry_id, gl_posted_at
-- targets a row that has already settled. Matches Odoo's pos.session closing-entry ordering
-- (state commit -> closing entry).

DROP TRIGGER IF EXISTS trg_pos_shift_close_journal ON public.pos_shifts;

CREATE OR REPLACE FUNCTION public.trg_pos_shift_close_journal_fn()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_journal_id uuid;
  v_err_msg text;
  v_err_state text;
BEGIN
  -- Only fire on the open->closed transition, and only if not yet posted.
  IF NEW.status = 'closed'
     AND (OLD.status IS DISTINCT FROM 'closed')
     AND NEW.journal_entry_id IS NULL THEN
    BEGIN
      -- post_pos_shift_gl is the single canonical poster; it performs its own
      -- UPDATE pos_shifts SET journal_entry_id=..., gl_posted_at=now().
      -- This is safe now because we are AFTER the outer row update.
      v_journal_id := public.post_pos_shift_gl(NEW.id);
      -- Do NOT assign NEW.* here; AFTER triggers cannot mutate NEW, and the
      -- function above already persists journal_entry_id and gl_posted_at.
    EXCEPTION WHEN OTHERS THEN
      v_err_msg := SQLERRM;
      v_err_state := SQLSTATE;
      INSERT INTO public.pos_shift_close_errors (
        shift_id, organization_id, business_id, error_message, error_detail
      ) VALUES (
        NEW.id, NEW.organization_id, NEW.business_id, v_err_msg,
        jsonb_build_object('sqlstate', v_err_state)
      );
      -- Re-raise so the close transaction rolls back. Odoo behavior:
      -- a session whose closing entry won't post must not be marked closed.
      RAISE EXCEPTION 'POS shift GL posting failed: %', v_err_msg;
    END;
  END IF;
  RETURN NULL; -- AFTER trigger return value is ignored.
END;
$function$;

CREATE TRIGGER trg_pos_shift_close_journal
  AFTER UPDATE OF status ON public.pos_shifts
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_pos_shift_close_journal_fn();