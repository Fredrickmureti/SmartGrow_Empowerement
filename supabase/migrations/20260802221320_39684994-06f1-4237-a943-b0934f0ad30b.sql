-- =========================================================================
-- Returns Phase 0 — event catalog repair (no behaviour change)
-- Align wms_events_catalog with the topics wms_transition_return actually
-- emits ('warehouse.return.' || state) and pre-declare the line-level
-- topics the returns execution flow will emit.
-- =========================================================================

INSERT INTO public.wms_events_catalog
  (topic, aggregate, transition, producers, consumers, payload_schema, description, idempotency_key_shape)
VALUES
  -- header FSM topics actually emitted today
  ('warehouse.return.draft',              'return', 'draft',              ARRAY['wms_transition_return'],            ARRAY['audit'],                        '{}'::jsonb, 'Return order created / reset to draft.',                                   'wms.return:{id}:draft'),
  ('warehouse.return.authorized',         'return', 'authorized',         ARRAY['wms_transition_return'],            ARRAY['sales','procurement','audit'],  '{}'::jsonb, 'RMA authorized; goods are expected at the warehouse.',                     'wms.return:{id}:authorized'),
  ('warehouse.return.in_transit',         'return', 'in_transit',         ARRAY['wms_transition_return'],            ARRAY['sales','audit'],                '{}'::jsonb, 'Returned goods are in transit to the warehouse.',                          'wms.return:{id}:in_transit'),
  ('warehouse.return.received',           'return', 'received',           ARRAY['wms_transition_return'],            ARRAY['inventory','qc','audit'],       '{}'::jsonb, 'Returned goods physically received at the dock.',                          'wms.return:{id}:received'),
  ('warehouse.return.inspecting',         'return', 'inspecting',         ARRAY['wms_transition_return'],            ARRAY['qc','audit'],                   '{}'::jsonb, 'Return inspection in progress.',                                          'wms.return:{id}:inspecting'),
  ('warehouse.return.disposed',           'return', 'disposed',           ARRAY['wms_transition_return'],            ARRAY['inventory','finance','audit'],  '{}'::jsonb, 'All return lines dispositioned and posted.',                               'wms.return:{id}:disposed'),
  ('warehouse.return.cancelled',          'return', 'cancelled',          ARRAY['wms_transition_return'],            ARRAY['sales','audit'],                '{}'::jsonb, 'Return order cancelled before completion.',                                'wms.return:{id}:cancelled'),

  -- line-level execution topics (Returns Phase 2 producers)
  ('warehouse.return.line_captured',      'return', 'line_captured',      ARRAY['wms_capture_return_line'],          ARRAY['inventory','qc','audit'],       '{}'::jsonb, 'A return line was captured at the dock (qty / lot / serial / LPN / condition).', 'wms.return:{id}:line_captured'),
  ('warehouse.return.line_inspected',     'return', 'line_inspected',     ARRAY['wms_inspect_return_line'],          ARRAY['qc','audit'],                   '{}'::jsonb, 'A return line inspection was recorded against a QC inspection.',           'wms.return:{id}:line_inspected'),
  ('warehouse.return.line_dispositioned', 'return', 'line_dispositioned', ARRAY['wms_disposition_return_line'],      ARRAY['inventory','finance','audit'],  '{}'::jsonb, 'A disposition was persisted on a return line.',                            'wms.return:{id}:line_dispositioned'),
  ('warehouse.return.dispositions_posted','return', 'dispositions_posted',ARRAY['wms_post_return_dispositions'],     ARRAY['inventory','finance','audit'],  '{}'::jsonb, 'Return dispositions posted to stock movements and follow-up tasks spawned.', 'wms.return:{id}:dispositions_posted'),
  ('warehouse.return.blocked',            'return', 'blocked',            ARRAY['wms_post_return_dispositions'],     ARRAY['supervisor','audit'],           '{}'::jsonb, 'A return line is blocked and an exception was raised for triage.',         'wms.return:{id}:blocked')
ON CONFLICT (topic) DO UPDATE SET
  aggregate             = EXCLUDED.aggregate,
  transition            = EXCLUDED.transition,
  producers             = EXCLUDED.producers,
  consumers             = EXCLUDED.consumers,
  payload_schema        = EXCLUDED.payload_schema,
  description           = EXCLUDED.description,
  idempotency_key_shape = EXCLUDED.idempotency_key_shape;

-- Legacy topics that were declared but never emitted by any producer.
-- Keep the rows (historic decoding) but strip the false producer claim.
UPDATE public.wms_events_catalog
SET producers   = ARRAY[]::text[],
    description = description || ' [DEPRECATED: never emitted; superseded by warehouse.return.received / line_inspected / line_dispositioned]'
WHERE topic IN (
  'warehouse.return.opened',
  'warehouse.return.inspected',
  'warehouse.return.dispositioned'
)
AND NOT description LIKE '%DEPRECATED%';