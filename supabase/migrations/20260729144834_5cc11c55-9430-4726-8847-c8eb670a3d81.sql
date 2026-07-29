
INSERT INTO public.wms_events_catalog
  (topic, aggregate, transition, producers, consumers, payload_schema, description, idempotency_key_shape)
VALUES
  ('warehouse.task.paused',   'task', 'paused',   ARRAY['wms_transition_task'], ARRAY['operator_ui','supervisor','labour'], '{}'::jsonb, 'Operator paused an in-progress task.',        'wms.task:{id}:paused:v{row_version}'),
  ('warehouse.task.resumed',  'task', 'resumed',  ARRAY['wms_transition_task'], ARRAY['operator_ui','supervisor','labour'], '{}'::jsonb, 'Operator resumed a previously paused task.', 'wms.task:{id}:resumed:v{row_version}')
ON CONFLICT (topic) DO NOTHING;
