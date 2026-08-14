-- Phase 8 behavioural sweep: a real stock adjustment surfaced that several
-- inventory/stock lifecycle topics were never registered in
-- public.business_event_topics. pos_topic_handler_scope() therefore fell back
-- to 'server', the server dispatcher claimed rows that were emitted with
-- handler_scope = 'host', and dead-lettered them as
-- "posting.contract_violation: unknown_event_type".

INSERT INTO public.business_event_topics
  (topic_prefix, producer_domain, consumer_domains, description, handler_scope)
VALUES
  ('stock.adjustment.posted', 'inventory', ARRAY['inventory','finance','analytics'],
   'Stock adjustment approved and applied. Consumed by the in-app stock lifecycle saga (cache invalidation, alerts).', 'host'),
  ('stock.transfer.approved', 'inventory', ARRAY['inventory','warehouse'],
   'Stock transfer approved. Consumed by the in-app stock lifecycle saga.', 'host'),
  ('stock.transfer.completed', 'inventory', ARRAY['inventory','warehouse','analytics'],
   'Stock transfer completed at destination. Consumed by the in-app stock lifecycle saga.', 'host'),
  ('stock.count.completed', 'inventory', ARRAY['inventory','analytics'],
   'Physical count completed. Consumed by the in-app stock lifecycle saga.', 'host'),
  ('stock.count.cancelled', 'inventory', ARRAY['inventory'],
   'Physical count cancelled. Consumed by the in-app stock lifecycle saga.', 'host'),
  ('inventory.physical_count.posted', 'inventory', ARRAY['inventory','finance','analytics'],
   'Physical count posted to the ledger. Server-scoped, record-only in the outbox dispatcher.', 'server'),
  ('inventory.reorder.recompute', 'inventory', ARRAY['inventory','replenishment'],
   'Reorder/replenishment recompute requested after a count post. Server-scoped, record-only in the outbox dispatcher.', 'server')
ON CONFLICT (topic_prefix) DO UPDATE
  SET handler_scope    = EXCLUDED.handler_scope,
      producer_domain  = EXCLUDED.producer_domain,
      consumer_domains = EXCLUDED.consumer_domains,
      description      = EXCLUDED.description,
      updated_at       = now();

-- Re-queue the event the server dispatcher wrongly claimed and failed.
UPDATE public.business_event_outbox
   SET status = 'pending', attempts = 0, last_error = NULL,
       claimed_at = NULL, worker_id = NULL, updated_at = now()
 WHERE event_type = 'stock.adjustment.posted'
   AND status = 'failed';