
CREATE OR REPLACE FUNCTION public._pos_bridge_close_to_stmt()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_stmt_id uuid;
  v_key text;
BEGIN
  IF NEW.status <> 'closed' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'closed' THEN RETURN NEW; END IF;

  v_key := 'register-period-close:' || NEW.id::text;
  v_stmt_id := public.open_pos_statement(
    NEW.id, 'shift_close'::pos_statement_close_kind, v_key);
  PERFORM public.close_pos_statement(
    v_stmt_id,
    jsonb_build_object(
      'counted_cash',  COALESCE(NEW.actual_cash, NEW.expected_cash, 0),
      'expected_cash', COALESCE(NEW.expected_cash, 0)),
    v_key);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  BEGIN
    INSERT INTO public.pos_shift_close_errors(shift_id, error_message, error_detail, occurred_at)
    VALUES (NEW.id, 'stmt_bridge_failed: ' || SQLERRM,
            jsonb_build_object('sqlstate', SQLSTATE), now());
  EXCEPTION WHEN OTHERS THEN NULL; END;
  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS trg_pos_bridge_close_to_stmt ON public.pos_shifts;
CREATE TRIGGER trg_pos_bridge_close_to_stmt
AFTER UPDATE OF status ON public.pos_shifts
FOR EACH ROW
WHEN (NEW.status = 'closed' AND (OLD.status IS DISTINCT FROM 'closed'))
EXECUTE FUNCTION public._pos_bridge_close_to_stmt();

CREATE OR REPLACE FUNCTION public._pos_stmt_stamp_register_period()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  IF NEW.shift_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.posting_status <> 'posted'::pos_statement_posting_status THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE'
     AND OLD.posting_status = 'posted'::pos_statement_posting_status
     AND OLD.journal_entry_id IS NOT DISTINCT FROM NEW.journal_entry_id
  THEN RETURN NEW; END IF;

  UPDATE public.pos_shifts
     SET gl_posted_at    = COALESCE(NEW.posted_at, now()),
         journal_entry_id = COALESCE(NEW.journal_entry_id, journal_entry_id),
         updated_at      = now()
   WHERE id = NEW.shift_id;
  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS trg_pos_stmt_stamp_register_period ON public.pos_statements;
CREATE TRIGGER trg_pos_stmt_stamp_register_period
AFTER INSERT OR UPDATE OF posting_status, journal_entry_id, posted_at
ON public.pos_statements
FOR EACH ROW
EXECUTE FUNCTION public._pos_stmt_stamp_register_period();

CREATE OR REPLACE FUNCTION public.post_pos_register_period_gl_now(p_shift_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_shift  public.pos_shifts%ROWTYPE;
  v_stmt_id uuid;
  v_key    text;
  v_result jsonb;
BEGIN
  SELECT * INTO v_shift FROM public.pos_shifts WHERE id = p_shift_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'register period % not found', p_shift_id USING ERRCODE='P0002';
  END IF;
  PERFORM public.assert_pos_caller_branch_access(v_shift.branch_id);
  IF v_shift.status <> 'closed' THEN
    RAISE EXCEPTION 'register period is not closed (status=%)', v_shift.status
      USING ERRCODE = 'check_violation';
  END IF;

  v_key := 'register-period-close:' || v_shift.id::text;
  v_stmt_id := public.open_pos_statement(
    v_shift.id, 'shift_close'::pos_statement_close_kind, v_key);
  PERFORM public.close_pos_statement(
    v_stmt_id,
    jsonb_build_object(
      'counted_cash',  COALESCE(v_shift.actual_cash, v_shift.expected_cash, 0),
      'expected_cash', COALESCE(v_shift.expected_cash, 0)),
    v_key);

  v_result := public.post_pos_statement_gl(v_stmt_id, v_key);
  RETURN v_result || jsonb_build_object('shift_id', v_shift.id, 'statement_id', v_stmt_id);
END $fn$;

GRANT EXECUTE ON FUNCTION public.post_pos_register_period_gl_now(uuid) TO authenticated;

DO $backfill$
DECLARE r RECORD; v_key text; v_stmt_id uuid;
BEGIN
  FOR r IN
    SELECT s.* FROM public.pos_shifts s
    LEFT JOIN public.pos_statements st ON st.shift_id = s.id
    WHERE s.status = 'closed'
      AND s.gl_posted_at IS NULL
      AND st.id IS NULL
  LOOP
    BEGIN
      v_key := 'register-period-close:' || r.id::text;
      v_stmt_id := public.open_pos_statement(r.id, 'shift_close'::pos_statement_close_kind, v_key);
      PERFORM public.close_pos_statement(
        v_stmt_id,
        jsonb_build_object(
          'counted_cash',  COALESCE(r.actual_cash, r.expected_cash, 0),
          'expected_cash', COALESCE(r.expected_cash, 0)),
        v_key);
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO public.pos_shift_close_errors(shift_id, error_message, error_detail, occurred_at)
      VALUES (r.id, 'backfill_stmt_bridge_failed: ' || SQLERRM,
              jsonb_build_object('sqlstate', SQLSTATE), now());
    END;
  END LOOP;
END $backfill$;
