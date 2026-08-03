INSERT INTO public.wms_events_catalog (topic, aggregate, transition, producers, consumers, description, idempotency_key_shape)
SELECT v.topic, 'crossdock_opportunity', v.transition,
       ARRAY['_wms_crossdock_detect','wms_crossdock_*'],
       ARRAY['CrossdockBoard','analytics'],
       v.descr,
       'wms.crossdock:{id}:{state}:{row_version}'
  FROM (VALUES
    ('warehouse.crossdock.qualified','qualified','Receipt line qualified against a waiting demand line.'),
    ('warehouse.crossdock.rejected','rejected','Cross-dock candidate rejected by policy or supervisor.'),
    ('warehouse.crossdock.approved','approved','Cross-dock approved for execution.'),
    ('warehouse.crossdock.staging','staging','Move-to-staging task issued.'),
    ('warehouse.crossdock.loaded','loaded','Cross-docked units loaded onto the outbound trailer.'),
    ('warehouse.crossdock.completed','completed','Cross-dock flow completed.'),
    ('warehouse.crossdock.broken','broken','Cross-dock plan broken on the floor.'),
    ('warehouse.crossdock.expired','expired','Cross-dock window elapsed before dispatch.')
  ) AS v(topic, transition, descr)
 WHERE NOT EXISTS (SELECT 1 FROM public.wms_events_catalog c WHERE c.topic = v.topic);