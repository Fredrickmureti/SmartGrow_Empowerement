-- Completeness: every emitted topic must be registered exactly, so the
-- prefix fallback can never silently mis-route a new topic again.
INSERT INTO public.business_event_topics
  (topic_prefix, producer_domain, consumer_domains, description, handler_scope)
VALUES
  ('procurement.landed_cost.posted', 'procurement', ARRAY['inventory','finance','analytics'],
   'Landed cost voucher posted (ADR 0077). Record-only lineage topic.', 'server'),
  ('procurement.landed_cost.reversed', 'procurement', ARRAY['inventory','finance','analytics'],
   'Landed cost voucher reversed. Record-only lineage topic.', 'server'),
  ('localization_pack.updated', 'platform', ARRAY['platform'],
   'Localization pack updated.', 'server'),
  ('pack.published', 'platform', ARRAY['platform'],
   'Localization pack published.', 'server')
ON CONFLICT (topic_prefix) DO UPDATE
  SET handler_scope    = EXCLUDED.handler_scope,
      producer_domain  = EXCLUDED.producer_domain,
      consumer_domains = EXCLUDED.consumer_domains,
      description      = EXCLUDED.description,
      updated_at       = now();