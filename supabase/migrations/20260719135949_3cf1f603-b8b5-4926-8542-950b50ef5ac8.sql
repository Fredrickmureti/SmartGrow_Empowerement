
CREATE OR REPLACE FUNCTION public._pos_stmt_enqueue_gl_post()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.closed_at IS NOT NULL
     AND NEW.posting_status = 'pending'::pos_statement_posting_status
     AND NEW.close_kind <> 'historical_backfill'::pos_statement_close_kind
     AND (TG_OP = 'INSERT'
          OR OLD.closed_at IS NULL
          OR OLD.posting_status <> 'pending'::pos_statement_posting_status)
  THEN
    -- NOTE: business_event_outbox is org+branch scoped; there is no business_id
    -- column on the outbox. The dispatcher re-derives business_id from the
    -- statement via source_doc_id. Do not add business_id here without also
    -- adding the column, or the whole statement close aborts with a hard 400.
    INSERT INTO public.business_event_outbox
      (org_id, branch_id, event_type, source_doc_type, source_doc_id,
       payload, source, idempotency_key, handler_scope)
    VALUES
      (NEW.organization_id, NEW.branch_id,
       'pos.statement.posting.requested',
       'pos_statement', NEW.id,
       jsonb_build_object(
         'statement_id',     NEW.id,
         'statement_number', NEW.statement_number,
         'shift_id',         NEW.shift_id,
         'business_id',      NEW.business_id,
         'close_kind',       NEW.close_kind,
         'total_sales',      NEW.total_sales,
         'total_returns',    NEW.total_returns,
         'total_tax',        NEW.total_tax
       ),
       'pos',
       'pos-stmt-post-' || NEW.id::text,
       'server')
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $function$;

COMMENT ON FUNCTION public._pos_stmt_enqueue_gl_post() IS
  'Enqueues pos.statement.posting.requested onto business_event_outbox when a POS statement closes. business_id lives inside payload — the outbox table has no business_id column. Do not add one without a coordinated schema change; every statement close would abort.';
