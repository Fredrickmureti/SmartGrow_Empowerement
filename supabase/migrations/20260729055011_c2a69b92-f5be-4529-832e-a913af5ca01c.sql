-- =========================================================================
-- Phase 2.0 — top up WMS event catalog and realtime membership
-- =========================================================================

-- 1) Seed the missing topic rows. `topic` is UNIQUE, so upsert on it.
INSERT INTO public.wms_events_catalog
  (topic, aggregate, transition, producers, consumers, payload_schema, description, idempotency_key_shape)
VALUES
  ('warehouse.receiving.opened',        'receiving', 'opened',        ARRAY['wms_transition_receiving'], ARRAY['inventory','finance','audit'], '{}'::jsonb, 'A receiving session was opened for a scheduled appointment / ASN.', 'wms.receiving:{id}:opened'),
  ('warehouse.receiving.line_captured', 'receiving', 'line_captured', ARRAY['wms_transition_receiving'], ARRAY['inventory','crossdock'],       '{}'::jsonb, 'A GRN line was captured against a receiving session.',              'wms.receiving:{id}:line_captured'),
  ('warehouse.receiving.closed',        'receiving', 'closed',        ARRAY['wms_transition_receiving'], ARRAY['inventory','finance','audit'], '{}'::jsonb, 'Receiving session posted and closed — inventory consumes it.',       'wms.receiving:{id}:closed'),
  ('warehouse.receiving.discrepant',    'receiving', 'discrepant',    ARRAY['wms_transition_receiving'], ARRAY['procurement','audit'],         '{}'::jsonb, 'Receiving session marked discrepant vs the source PO / ASN.',        'wms.receiving:{id}:discrepant'),

  ('warehouse.return.opened',           'return',    'opened',        ARRAY['wms_transition_return'],    ARRAY['sales','inventory','audit'],   '{}'::jsonb, 'Return order opened at the warehouse.',                              'wms.return:{id}:opened'),
  ('warehouse.return.inspected',        'return',    'inspected',     ARRAY['wms_transition_return'],    ARRAY['qc','audit'],                  '{}'::jsonb, 'Return inspection complete; awaiting disposition.',                  'wms.return:{id}:inspected'),
  ('warehouse.return.dispositioned',    'return',    'dispositioned', ARRAY['wms_transition_return'],    ARRAY['inventory','finance','audit'], '{}'::jsonb, 'Return disposition set (restock / quarantine / scrap / refurbish).', 'wms.return:{id}:dispositioned'),
  ('warehouse.return.closed',           'return',    'closed',        ARRAY['wms_transition_return'],    ARRAY['inventory','finance','audit'], '{}'::jsonb, 'Return closed and consumed by downstream ledgers.',                  'wms.return:{id}:closed'),

  ('warehouse.exception.raised',        'exception', 'raised',        ARRAY['wms_raise_exception'],      ARRAY['supervisor','audit'],          '{}'::jsonb, 'A WMS exception was raised for triage.',                             'wms.exception:{id}:raised'),
  ('warehouse.exception.resolved',      'exception', 'resolved',      ARRAY['wms_resolve_exception'],    ARRAY['supervisor','audit'],          '{}'::jsonb, 'A WMS exception moved to a terminal state.',                         'wms.exception:{id}:resolved')
ON CONFLICT (topic) DO UPDATE SET
  aggregate = EXCLUDED.aggregate,
  transition = EXCLUDED.transition,
  producers = EXCLUDED.producers,
  consumers = EXCLUDED.consumers,
  description = EXCLUDED.description,
  idempotency_key_shape = EXCLUDED.idempotency_key_shape,
  updated_at = now();

-- 2) Add missing WMS aggregates to the realtime publication. Idempotent
--    via DO block because ALTER PUBLICATION ADD TABLE errors on duplicates.
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'wms_tasks',
    'wms_license_plates',
    'wms_events_catalog'
  ])
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_publication_rel pr
      JOIN pg_publication p ON p.oid = pr.prpubid
      JOIN pg_class c       ON c.oid = pr.prrelid
      JOIN pg_namespace n   ON n.oid = c.relnamespace
      WHERE p.pubname = 'supabase_realtime'
        AND n.nspname = 'public'
        AND c.relname = t
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    END IF;
  END LOOP;
END $$;

-- 3) REPLICA IDENTITY FULL for the two hot-path aggregate tables so realtime
--    delivers the previous row on UPDATE (needed by supervisor boards that
--    diff state transitions).
ALTER TABLE public.wms_tasks          REPLICA IDENTITY FULL;
ALTER TABLE public.wms_license_plates REPLICA IDENTITY FULL;