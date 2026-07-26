ALTER TABLE public.workstations
  ADD COLUMN IF NOT EXISTS tls_fingerprint_sha256 text,
  ADD COLUMN IF NOT EXISTS tls_port integer,
  ADD COLUMN IF NOT EXISTS tls_generated_at timestamptz,
  ADD COLUMN IF NOT EXISTS tls_trusted boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.workstations.tls_fingerprint_sha256 IS 'SHA-256 fingerprint of the per-install loopback TLS certificate, published by the Edge agent manifest. Used by the browser client to pin the https://127.0.0.1 transport.';
COMMENT ON COLUMN public.workstations.tls_trusted IS 'Set by the desktop shell once the operator has installed the loopback certificate into the OS trust store.';

DO $$
BEGIN
  PERFORM cron.unschedule('edge_jobs_purge_stale');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

SELECT cron.schedule(
  'edge_jobs_purge_stale',
  '17 3 * * *',
  $$SELECT public.edge_jobs_expire_stale();$$
);