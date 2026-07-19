
CREATE TABLE IF NOT EXISTS public.accounting_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  business_id uuid,
  branch_id uuid,
  producer text NOT NULL,
  producer_doc_type text NOT NULL,
  producer_doc_id uuid NOT NULL,
  event_kind text NOT NULL,
  state text NOT NULL DEFAULT 'draft'
    CHECK (state IN ('draft','ready','needs_mapping','needs_period','invalid',
                     'posting','posted','failed','superseded','cancelled','blocked','noop')),
  business_idempotency_key text NOT NULL,
  amount numeric,
  currency_code text,
  business_date date,
  requested_at timestamptz NOT NULL DEFAULT now(),
  validated_at timestamptz,
  posted_at timestamptz,
  journal_entry_id uuid,
  last_diagnostic jsonb,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT accounting_events_bidempotency_uk UNIQUE (business_idempotency_key)
);

CREATE INDEX IF NOT EXISTS accounting_events_org_state_idx
  ON public.accounting_events (org_id, state, requested_at DESC);
CREATE INDEX IF NOT EXISTS accounting_events_producer_doc_idx
  ON public.accounting_events (producer, producer_doc_type, producer_doc_id);
CREATE INDEX IF NOT EXISTS accounting_events_branch_idx
  ON public.accounting_events (branch_id) WHERE branch_id IS NOT NULL;

GRANT SELECT ON public.accounting_events TO authenticated;
GRANT ALL    ON public.accounting_events TO service_role;

ALTER TABLE public.accounting_events ENABLE ROW LEVEL SECURITY;

-- Mirrors the canonical pos_statements read policy so the operations
-- workspace inherits identical branch scoping. Branch-less events
-- (rare; org-wide accruals) are visible only to service_role.
CREATE POLICY accounting_events_branch_read
  ON public.accounting_events
  FOR SELECT TO authenticated
  USING (
    branch_id IS NOT NULL
    AND public.user_can_access_branch(auth.uid(), branch_id)
  );

CREATE POLICY accounting_events_service_write
  ON public.accounting_events
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION public._accounting_events_touch()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS trg_accounting_events_touch ON public.accounting_events;
CREATE TRIGGER trg_accounting_events_touch
  BEFORE UPDATE ON public.accounting_events
  FOR EACH ROW EXECUTE FUNCTION public._accounting_events_touch();

-- Extend (not replace) the existing POS statement enqueue trigger so
-- B2 is safe standalone. Dual-write is wrapped so it can never abort a
-- shift close.
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
         'pos:pos_statement:' || NEW.id::text || ':v1',
         COALESCE(NEW.total_sales, 0) - COALESCE(NEW.total_returns, 0),
         (NEW.closed_at AT TIME ZONE 'UTC')::date,
         now(),
         jsonb_build_object(
           'source', 'pos_statement.close_trigger',
           'statement_number', NEW.statement_number,
           'close_kind', NEW.close_kind
         ))
      ON CONFLICT (business_idempotency_key) DO NOTHING;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'accounting_events dual-write skipped for pos_statement %: %',
        NEW.id, SQLERRM;
    END;
  END IF;
  RETURN NEW;
END $function$;

-- One-time backfill of existing POS statements. Idempotent via UNIQUE
-- business_idempotency_key so re-running is safe.
INSERT INTO public.accounting_events
  (org_id, business_id, branch_id,
   producer, producer_doc_type, producer_doc_id,
   event_kind, state, business_idempotency_key,
   amount, business_date, requested_at, posted_at,
   journal_entry_id, last_diagnostic)
SELECT
  s.organization_id, s.business_id, s.branch_id,
  'pos', 'pos_statement', s.id,
  'shift_close',
  CASE s.posting_status::text
    WHEN 'posted'     THEN 'posted'
    WHEN 'reversed'   THEN 'superseded'
    WHEN 'historical' THEN 'noop'
    ELSE 'ready'
  END,
  'pos:pos_statement:' || s.id::text || ':v1',
  COALESCE(s.total_sales, 0) - COALESCE(s.total_returns, 0),
  (COALESCE(s.closed_at, s.created_at) AT TIME ZONE 'UTC')::date,
  COALESCE(s.closed_at, s.created_at),
  s.posted_at,
  s.journal_entry_id,
  jsonb_build_object(
    'source', 'b2_backfill',
    'statement_number', s.statement_number,
    'close_kind', s.close_kind,
    'original_posting_status', s.posting_status::text
  )
FROM public.pos_statements s
ON CONFLICT (business_idempotency_key) DO NOTHING;
