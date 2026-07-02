CREATE TABLE IF NOT EXISTS public.pos_shift_close_errors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_id uuid NOT NULL REFERENCES public.pos_shifts(id) ON DELETE CASCADE,
  organization_id uuid,
  business_id uuid,
  error_message text NOT NULL,
  error_detail jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.pos_shift_close_errors ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "shift_close_errors_business_select" ON public.pos_shift_close_errors;
CREATE POLICY "shift_close_errors_business_select"
ON public.pos_shift_close_errors FOR SELECT
USING (
  business_id IS NOT NULL
  AND public.user_has_business_access(auth.uid(), business_id)
);

CREATE OR REPLACE FUNCTION public.trg_pos_shift_close_journal_fn()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_journal_id uuid;
  v_err_msg text;
  v_err_state text;
BEGIN
  IF NEW.status = 'closed'
     AND (OLD.status IS DISTINCT FROM 'closed')
     AND NEW.journal_entry_id IS NULL THEN
    BEGIN
      v_journal_id := public.post_pos_shift_gl(NEW.id);
      IF v_journal_id IS NOT NULL THEN
        NEW.journal_entry_id := v_journal_id;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_err_msg := SQLERRM;
      v_err_state := SQLSTATE;
      INSERT INTO public.pos_shift_close_errors (
        shift_id, organization_id, business_id, error_message, error_detail
      ) VALUES (
        NEW.id, NEW.organization_id, NEW.business_id, v_err_msg,
        jsonb_build_object('sqlstate', v_err_state)
      );
      RAISE EXCEPTION 'POS shift GL posting failed: %', v_err_msg;
    END;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pos_shift_close_journal ON public.pos_shifts;
CREATE TRIGGER trg_pos_shift_close_journal
BEFORE UPDATE OF status ON public.pos_shifts
FOR EACH ROW EXECUTE FUNCTION public.trg_pos_shift_close_journal_fn();

CREATE OR REPLACE FUNCTION public.trg_pos_shift_refresh_daily_summary_fn()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'closed' AND (OLD.status IS DISTINCT FROM 'closed') THEN
    BEGIN
      PERFORM public.update_pos_daily_summary(
        NEW.organization_id,
        NEW.business_id,
        COALESCE(NEW.closed_at, now())::date
      );
    EXCEPTION WHEN OTHERS THEN
      -- Do not block close on summary failure; it can be recomputed.
      NULL;
    END;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pos_shift_refresh_daily_summary ON public.pos_shifts;
CREATE TRIGGER trg_pos_shift_refresh_daily_summary
AFTER UPDATE OF status ON public.pos_shifts
FOR EACH ROW EXECUTE FUNCTION public.trg_pos_shift_refresh_daily_summary_fn();