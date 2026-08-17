-- INV-SIM 2026-08-17: wms_lpn_status_edges had no outgoing edge from 'open'
-- except 'receiving', but the app creates plates as 'open' and wms_lpn_seal /
-- wms_lpn_dispatch / wms_lpn_retire target sealed / shipped / retired. Every
-- plate built on the floor was un-sealable and un-dispatchable
-- ("wms_lpn_bad_edge: open -> sealed").

INSERT INTO public.wms_lpn_status_edges (from_status, to_status, verb, description, requires_reason, rpc_name, sort_order)
VALUES
  ('open'::public.wms_lpn_status,   'packed'::public.wms_lpn_status,      'Pack',           'Close out a working plate as packed',        false, NULL,                  55),
  ('open'::public.wms_lpn_status,   'sealed'::public.wms_lpn_status,      'Seal',           'Seal a working plate built on the floor',    false, 'wms_lpn_seal',        56),
  ('open'::public.wms_lpn_status,   'staged'::public.wms_lpn_status,      'Stage',          'Stage a working plate for dispatch',         false, NULL,                  57),
  ('open'::public.wms_lpn_status,   'quarantined'::public.wms_lpn_status, 'Quarantine',     'Hold a working plate',                       true,  NULL,                  58),
  ('open'::public.wms_lpn_status,   'retired'::public.wms_lpn_status,     'Retire',         'Retire an empty or damaged working plate',   true,  'wms_lpn_retire',      59),
  ('open'::public.wms_lpn_status,   'voided'::public.wms_lpn_status,      'Void',           'Void a working plate created in error',      true,  NULL,                  60),
  ('sealed'::public.wms_lpn_status, 'shipped'::public.wms_lpn_status,     'Dispatch',       'Dispatch a sealed plate',                    false, 'wms_lpn_dispatch',    91),
  ('staged'::public.wms_lpn_status, 'shipped'::public.wms_lpn_status,     'Dispatch',       'Dispatch a staged plate',                    false, 'wms_lpn_dispatch',    92),
  ('sealed'::public.wms_lpn_status, 'open'::public.wms_lpn_status,        'Break seal',     'Re-open a sealed plate to change contents',  true,  NULL,                  93)
ON CONFLICT (from_status, to_status) DO NOTHING;

DO $check$
DECLARE v_missing text;
BEGIN
  SELECT string_agg(t.s, ', ')
    INTO v_missing
    FROM (VALUES ('sealed'), ('shipped'), ('retired'), ('quarantined')) AS t(s)
   WHERE NOT EXISTS (
     SELECT 1 FROM public.wms_lpn_status_edges e
      WHERE e.from_status::text IN ('open', 'sealed', 'staged', 'loaded')
        AND e.to_status::text = t.s
   );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'plate lifecycle still unreachable for: %', v_missing;
  END IF;
END $check$;