
-- ============================================================
-- B6 — Delete POS-specific posting infrastructure
-- ============================================================

-- 1) Drop the POS-specific manual-retry RPC. Superseded by
--    public.accounting_post_event(). No UI callers remain (verified
--    via ripgrep). The Accounting Events workspace invokes the engine
--    directly.
DROP FUNCTION IF EXISTS public.retry_pos_statement_posting(uuid, text);

-- 2) Extend the POS statement close trigger to carry the
--    accounting_event_id in the outbox payload, so the dispatcher can
--    resolve the event with zero extra round-trips (and the fallback
--    lookup exists only for legacy rows).
CREATE OR REPLACE FUNCTION public._pos_stmt_enqueue_gl_post()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_event_id  uuid;
  v_idem_key  text;
BEGIN
  IF NEW.closed_at IS NOT NULL
     AND NEW.posting_status = 'pending'::pos_statement_posting_status
     AND NEW.close_kind <> 'historical_backfill'::pos_statement_close_kind
     AND (TG_OP = 'INSERT'
          OR OLD.closed_at IS NULL
          OR OLD.posting_status <> 'pending'::pos_statement_posting_status)
  THEN
    v_idem_key := 'pos:pos_statement:' || NEW.id::text || ':v1';

    -- Sub-ledger event first — this is now the source of truth for
    -- posting state. Wrapped so producer failure never blocks a shift
    -- close (sale-path invariant), but the WARNING will surface in
    -- Postgres logs.
    BEGIN
      INSERT INTO public.accounting_events
        (org_id, business_id, branch_id,
         producer, producer_doc_type, producer_doc_id,
         event_kind, state, business_idempotency_key,
         amount, business_date, requested_at, last_diagnostic)
      VALUES
        (NEW.organization_id, NEW.business_id, NEW.branch_id,
         'pos', 'pos_statement', NEW.id,
         'shift_close', 'ready',
         v_idem_key,
         COALESCE(NEW.total_sales, 0) - COALESCE(NEW.total_returns, 0),
         (NEW.closed_at AT TIME ZONE 'UTC')::date,
         now(),
         jsonb_build_object(
           'source', 'pos_statement.close_trigger',
           'statement_number', NEW.statement_number,
           'close_kind', NEW.close_kind
         ))
      ON CONFLICT (business_idempotency_key) DO NOTHING
      RETURNING id INTO v_event_id;

      IF v_event_id IS NULL THEN
        SELECT id INTO v_event_id
        FROM public.accounting_events
        WHERE business_idempotency_key = v_idem_key;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'accounting_events dual-write skipped for pos_statement %: %',
        NEW.id, SQLERRM;
      v_event_id := NULL;
    END;

    -- Outbox transport: carries accounting_event_id so the dispatcher
    -- never needs the statement→event lookup on the hot path.
    INSERT INTO public.business_event_outbox
      (org_id, branch_id, event_type, source_doc_type, source_doc_id,
       payload, source, idempotency_key, handler_scope)
    VALUES
      (NEW.organization_id, NEW.branch_id,
       'pos.statement.posting.requested',
       'pos_statement', NEW.id,
       jsonb_build_object(
         'statement_id',         NEW.id,
         'accounting_event_id',  v_event_id,
         'statement_number',     NEW.statement_number,
         'shift_id',             NEW.shift_id,
         'business_id',          NEW.business_id,
         'close_kind',           NEW.close_kind,
         'total_sales',          NEW.total_sales,
         'total_returns',        NEW.total_returns,
         'total_tax',            NEW.total_tax
       ),
       'pos',
       'pos-stmt-post-' || NEW.id::text,
       'server')
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $function$;

COMMENT ON FUNCTION public._pos_stmt_enqueue_gl_post() IS
  'B6: emits sub-ledger accounting_event first, then outbox transport carrying accounting_event_id. Dispatcher routes through accounting_post_event (single Posting Engine). Wrapped accounting_events insert cannot abort the shift close.';
