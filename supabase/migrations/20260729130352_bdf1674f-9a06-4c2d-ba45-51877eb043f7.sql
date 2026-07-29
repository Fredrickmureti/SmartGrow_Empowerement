INSERT INTO public.wms_events_catalog (topic, aggregate, transition, producers, consumers, description, idempotency_key_shape)
VALUES (
  'warehouse.replen.enqueued',
  'replen',
  '->enqueued',
  ARRAY['_wms_maybe_enqueue_replen'],
  ARRAY['replenishment_board','labour'],
  'Pick-face fell below replenishment rule minimum; an auto replenish task was enqueued.',
  'wms.replen:<product_id>:<pick_location_id>:<minute_bucket>'
)
ON CONFLICT (topic) DO NOTHING;