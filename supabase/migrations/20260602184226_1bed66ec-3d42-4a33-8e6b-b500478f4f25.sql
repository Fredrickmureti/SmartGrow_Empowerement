
-- 1. Drift log table.
CREATE TABLE public.control_account_drift_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  account_id uuid NOT NULL,
  account_code text,
  account_name text,
  system_role text,
  gl_balance numeric NOT NULL,
  subledger_balance numeric NOT NULL,
  drift numeric NOT NULL,
  snapshot_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_drift_log_org_time
  ON public.control_account_drift_log (organization_id, snapshot_at DESC);

GRANT SELECT ON public.control_account_drift_log TO authenticated;
GRANT ALL    ON public.control_account_drift_log TO service_role;

ALTER TABLE public.control_account_drift_log ENABLE ROW LEVEL SECURITY;

-- Use the existing user_belongs_to_org(org_id uuid) helper.
CREATE POLICY "Members can read their org's drift log"
  ON public.control_account_drift_log
  FOR SELECT
  TO authenticated
  USING (public.user_belongs_to_org(organization_id));

-- 2. Snapshot routine.
CREATE OR REPLACE FUNCTION public.snapshot_control_account_drift()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  INSERT INTO public.control_account_drift_log
    (organization_id, account_id, account_code, account_name, system_role,
     gl_balance, subledger_balance, drift)
  SELECT organization_id, account_id, account_code, account_name, system_role,
         gl_balance, subledger_balance, drift
  FROM public.control_account_tieout
  WHERE abs(drift) > 0.005;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.snapshot_control_account_drift() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.snapshot_control_account_drift() TO service_role;

-- 3. Schedule daily at 02:00 UTC. Idempotent.
DO $$
BEGIN
  PERFORM cron.unschedule('snapshot_control_account_drift_daily');
EXCEPTION WHEN OTHERS THEN
  NULL;
END$$;

SELECT cron.schedule(
  'snapshot_control_account_drift_daily',
  '0 2 * * *',
  $$ SELECT public.snapshot_control_account_drift(); $$
);
