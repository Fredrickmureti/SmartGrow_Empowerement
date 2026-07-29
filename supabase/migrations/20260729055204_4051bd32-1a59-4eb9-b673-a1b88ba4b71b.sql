-- Phase 2.0 — mirror the Phase 1 task / LPN topic seed in the migrations
-- folder so the wms-topic-catalog-sync architecture guard can enforce
-- parity between src/features/warehouse/events/topics.ts and the on-disk
-- migration history. Idempotent — the underlying rows already exist.

INSERT INTO public.wms_events_catalog
  (topic, aggregate, transition, producers, consumers, payload_schema, description, idempotency_key_shape)
VALUES
  ('warehouse.task.available',   'task', 'available',   ARRAY['wms_transition_task','wms_task_reap_expired'], ARRAY['operator_ui','supervisor'], '{}'::jsonb, 'Task returned to the queue (created, released, or reaped).',       'wms.task:{id}:available'),
  ('warehouse.task.claimed',     'task', 'claimed',     ARRAY['wms_transition_task','wms_claim_next_task'],    ARRAY['operator_ui','supervisor'], '{}'::jsonb, 'An operator claimed a task from the queue.',                       'wms.task:{id}:claimed'),
  ('warehouse.task.in_progress', 'task', 'in_progress', ARRAY['wms_transition_task'],                          ARRAY['operator_ui','supervisor','labour'], '{}'::jsonb, 'Task work started.',                                     'wms.task:{id}:in_progress'),
  ('warehouse.task.completed',   'task', 'completed',   ARRAY['wms_transition_task'],                          ARRAY['inventory','labour','supervisor'],   '{}'::jsonb, 'Task completed successfully.',                           'wms.task:{id}:completed'),
  ('warehouse.task.exception',   'task', 'exception',   ARRAY['wms_transition_task'],                          ARRAY['supervisor','exception_inbox'],      '{}'::jsonb, 'Task moved to exception state — needs triage.',         'wms.task:{id}:exception'),
  ('warehouse.task.cancelled',   'task', 'cancelled',   ARRAY['wms_transition_task'],                          ARRAY['supervisor','audit'],                '{}'::jsonb, 'Task cancelled.',                                        'wms.task:{id}:cancelled'),

  ('warehouse.lpn.receiving',    'lpn',  'receiving',   ARRAY['wms_transition_lpn'], ARRAY['receiving','audit'],                 '{}'::jsonb, 'License plate created / accepted at receiving.',            'wms.lpn:{id}:receiving'),
  ('warehouse.lpn.putaway',      'lpn',  'putaway',     ARRAY['wms_transition_lpn'], ARRAY['operator_ui','audit'],               '{}'::jsonb, 'License plate assigned to putaway.',                        'wms.lpn:{id}:putaway'),
  ('warehouse.lpn.stored',       'lpn',  'stored',      ARRAY['wms_transition_lpn'], ARRAY['inventory','audit'],                 '{}'::jsonb, 'License plate stored in its destination bin.',              'wms.lpn:{id}:stored'),
  ('warehouse.lpn.picked',       'lpn',  'picked',      ARRAY['wms_transition_lpn'], ARRAY['operator_ui','audit'],               '{}'::jsonb, 'License plate contents picked.',                            'wms.lpn:{id}:picked'),
  ('warehouse.lpn.packed',       'lpn',  'packed',      ARRAY['wms_transition_lpn'], ARRAY['operator_ui','audit'],               '{}'::jsonb, 'License plate packed into a shipping carton.',              'wms.lpn:{id}:packed'),
  ('warehouse.lpn.staged',       'lpn',  'staged',      ARRAY['wms_transition_lpn'], ARRAY['dispatch','audit'],                  '{}'::jsonb, 'License plate staged at the outbound dock.',                'wms.lpn:{id}:staged'),
  ('warehouse.lpn.loaded',       'lpn',  'loaded',      ARRAY['wms_transition_lpn'], ARRAY['dispatch','audit'],                  '{}'::jsonb, 'License plate loaded onto a trailer.',                      'wms.lpn:{id}:loaded'),
  ('warehouse.lpn.shipped',      'lpn',  'shipped',     ARRAY['wms_transition_lpn'], ARRAY['inventory','finance','audit'],       '{}'::jsonb, 'License plate shipped — inventory issues.',                 'wms.lpn:{id}:shipped'),
  ('warehouse.lpn.quarantined',  'lpn',  'quarantined', ARRAY['wms_transition_lpn'], ARRAY['qc','inventory','audit'],            '{}'::jsonb, 'License plate placed on hold / quarantine.',                'wms.lpn:{id}:quarantined'),
  ('warehouse.lpn.voided',       'lpn',  'voided',      ARRAY['wms_transition_lpn'], ARRAY['audit'],                             '{}'::jsonb, 'License plate voided.',                                     'wms.lpn:{id}:voided')
ON CONFLICT (topic) DO NOTHING;