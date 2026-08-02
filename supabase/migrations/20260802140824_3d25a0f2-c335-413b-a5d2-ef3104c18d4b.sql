-- ADR 0105 — Phase 4.5: revoke client write privileges on the Packaging Master.
-- Every mutation is owned by a SECURITY DEFINER RPC (assign_packaging_to_pack,
-- wms_sscc_allocate, ...). RLS already blocks these writes, but the grants left
-- the tables one bad policy away from exposure. Defence in depth: remove the
-- privilege itself; keep read access for authenticated (RLS still scopes rows).

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'wms_packaging_types',
    'wms_packaging_carriers',
    'wms_packaging_availability',
    'wms_packaging_events',
    'wms_sscc_registry',
    'wms_sscc_events',
    'wms_gs1_config'
  ] LOOP
    EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.%I FROM authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
  END LOOP;
END $$;