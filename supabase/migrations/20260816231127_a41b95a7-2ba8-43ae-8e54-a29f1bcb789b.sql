-- P0-4 (milk simulation): these lifecycle topics were emitted by triggers but
-- never registered in public.business_event_topics, so pos_topic_handler_scope
-- fell back to 'server' with no dispatcher entry and every occurrence
-- dead-lettered as "posting.contract_violation: unknown_event_type".
-- They are now explicitly server-scoped and record-only in the dispatcher.
INSERT INTO public.business_event_topics
  (topic_prefix, producer_domain, consumer_domains, description, handler_scope)
VALUES
  ('procurement.po.submitted', 'procurement', ARRAY['procurement','analytics'],
   'Purchase order submitted for approval. Record-only lineage topic.', 'server'),
  ('procurement.po.approved', 'procurement', ARRAY['procurement','warehouse','inventory','analytics'],
   'Purchase order approved; expected supply becomes committed (ADR 0102).', 'server'),
  ('procurement.asn.created', 'procurement', ARRAY['warehouse','procurement'],
   'Advance shipping notice created against a purchase order.', 'server'),
  ('procurement.asn.dispatched', 'procurement', ARRAY['warehouse','procurement'],
   'Advance shipping notice dispatched by the supplier.', 'server'),
  ('procurement.asn.in_transit', 'procurement', ARRAY['warehouse','procurement'],
   'Advance shipping notice in transit.', 'server'),
  ('procurement.asn.arrived', 'procurement', ARRAY['warehouse','procurement'],
   'Advance shipping notice arrived at the receiving dock.', 'server'),
  ('procurement.gr.posted', 'procurement', ARRAY['inventory','finance','warehouse','analytics'],
   'Goods receipt posted: stock and the GRNI accrual are already durable.', 'server'),
  ('goods_receipt.posted', 'procurement', ARRAY['inventory','finance','analytics'],
   'Legacy alias of procurement.gr.posted emitted by the receipt trigger.', 'server'),
  ('product.created', 'inventory', ARRAY['inventory','analytics'],
   'Product master created. Record-only lineage topic.', 'server'),
  ('payment.received', 'finance', ARRAY['finance','analytics'],
   'Customer payment received. Record-only lineage topic.', 'server'),
  ('delivery_note.dispatched', 'sales', ARRAY['inventory','sales','analytics'],
   'Delivery note dispatched; the outbound movement is already posted.', 'server'),
  ('delivery_note.completed', 'sales', ARRAY['sales','analytics'],
   'Delivery note completed (proof of delivery captured).', 'server'),
  ('stock_transfer.dispatched', 'inventory', ARRAY['inventory','warehouse'],
   'Stock transfer dispatched from the source warehouse.', 'server'),
  ('stock_transfer.received', 'inventory', ARRAY['inventory','warehouse'],
   'Stock transfer received at the destination warehouse.', 'server'),
  ('warehouse.receipt.staged', 'warehouse', ARRAY['warehouse','inventory'],
   'Received goods staged on a licence plate at the receiving location.', 'server'),
  ('warehouse.receiving.unloading', 'warehouse', ARRAY['warehouse'],
   'Receiving session moved to unloading.', 'server'),
  ('warehouse.receiving.captured', 'warehouse', ARRAY['warehouse'],
   'Receiving session capture completed.', 'server'),
  ('warehouse.receiving.line_captured', 'warehouse', ARRAY['warehouse','inventory'],
   'A single receiving line was captured (base-unit quantity).', 'server'),
  ('warehouse.receiving.posted', 'warehouse', ARRAY['warehouse','inventory','finance','analytics'],
   'Receiving session posted; goods receipt and accrual are durable.', 'server'),
  ('warehouse.exception.raised', 'warehouse', ARRAY['warehouse'],
   'Warehouse exception raised during receiving/putaway.', 'server'),
  ('warehouse.exception.escalated', 'warehouse', ARRAY['warehouse'],
   'Warehouse exception escalated to a supervisor.', 'server')
ON CONFLICT (topic_prefix) DO UPDATE
  SET handler_scope    = EXCLUDED.handler_scope,
      producer_domain  = EXCLUDED.producer_domain,
      consumer_domains = EXCLUDED.consumer_domains,
      description      = EXCLUDED.description,
      updated_at       = now();

-- Replay everything these topics dead-lettered, and re-queue any still-failed
-- occurrence, now that the dispatcher recognises them.
WITH replayed AS (
  DELETE FROM public.business_event_outbox_dead d
   WHERE d.event_type IN (
     'procurement.po.submitted','procurement.po.approved',
     'procurement.asn.created','procurement.asn.dispatched',
     'procurement.asn.in_transit','procurement.asn.arrived',
     'procurement.gr.posted','goods_receipt.posted','product.created',
     'payment.received','delivery_note.dispatched','delivery_note.completed',
     'stock_transfer.dispatched','stock_transfer.received',
     'warehouse.receipt.staged','warehouse.receiving.unloading',
     'warehouse.receiving.captured','warehouse.receiving.line_captured',
     'warehouse.receiving.posted','warehouse.exception.raised',
     'warehouse.exception.escalated')
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

UPDATE public.business_event_outbox
   SET status = 'pending', attempts = 0, last_error = NULL,
       claimed_at = NULL, worker_id = NULL,
       handler_scope = 'server', updated_at = now()
 WHERE status = 'failed'
   AND event_type IN (
     'procurement.po.submitted','procurement.po.approved',
     'procurement.asn.created','procurement.asn.dispatched',
     'procurement.asn.in_transit','procurement.asn.arrived',
     'procurement.gr.posted','goods_receipt.posted','product.created',
     'payment.received','delivery_note.dispatched','delivery_note.completed',
     'stock_transfer.dispatched','stock_transfer.received',
     'warehouse.receipt.staged','warehouse.receiving.unloading',
     'warehouse.receiving.captured','warehouse.receiving.line_captured',
     'warehouse.receiving.posted','warehouse.exception.raised',
     'warehouse.exception.escalated');