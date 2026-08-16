-- P0-4 continued: POS payment-session lifecycle topics had no registration and
-- no consumer, so they dead-lettered as unknown_event_type. The session state
-- machine is already durable; these are record-only lineage topics.
INSERT INTO public.business_event_topics
  (topic_prefix, producer_domain, consumer_domains, description, handler_scope)
VALUES
  ('pos.payment.session.opened', 'pos', ARRAY['pos','analytics'],
   'POS payment session opened. Record-only lineage topic.', 'server'),
  ('pos.payment.session.committed', 'pos', ARRAY['pos','finance','analytics'],
   'POS payment session committed. Record-only lineage topic.', 'server'),
  ('pos.payment.tender.recorded', 'pos', ARRAY['pos','finance','analytics'],
   'A tender line was recorded on a POS payment session.', 'server'),
  ('shift.opened', 'pos', ARRAY['pos','analytics'],
   'POS shift opened. Record-only lineage topic.', 'server')
ON CONFLICT (topic_prefix) DO UPDATE
  SET handler_scope    = EXCLUDED.handler_scope,
      producer_domain  = EXCLUDED.producer_domain,
      consumer_domains = EXCLUDED.consumer_domains,
      description      = EXCLUDED.description,
      updated_at       = now();

-- Replay every remaining dead letter now that the dispatcher recognises them.
WITH replayed AS (
  DELETE FROM public.business_event_outbox_dead d
   WHERE d.dead_reason ILIKE '%unknown_event_type%'
      OR d.last_error  ILIKE '%unknown_event_type%'
  RETURNING *
)
INSERT INTO public.business_event_outbox
  (id, org_id, branch_id, warehouse_id, event_type, source_doc_type,
   source_doc_id, payload, status, attempts, idempotency_key, actor_user_id,
   created_at, source, handler_scope)
SELECT r.id, r.org_id, r.branch_id, r.warehouse_id, r.event_type,
       r.source_doc_type, r.source_doc_id, r.payload, 'pending', 0,
       r.idempotency_key, r.actor_user_id, r.original_created_at,
       COALESCE(r.source, 'system'), 'server'
  FROM replayed r
ON CONFLICT (idempotency_key) DO NOTHING;

-- Re-queue every failed occurrence of a now-registered topic.
UPDATE public.business_event_outbox o
   SET status = 'pending', attempts = 0, last_error = NULL,
       claimed_at = NULL, worker_id = NULL,
       handler_scope = bt.handler_scope, updated_at = now()
  FROM public.business_event_topics bt
 WHERE bt.topic_prefix = o.event_type
   AND o.status = 'failed';