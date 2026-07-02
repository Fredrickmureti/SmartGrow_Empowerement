
CREATE OR REPLACE FUNCTION public.run_identity_drift_check()
RETURNS TABLE (
  organization_id uuid,
  org_name text,
  primary_business_id uuid,
  primary_legal_name text,
  business_count int,
  drift_kind text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH primary_biz AS (
    SELECT DISTINCT ON (b.organization_id)
      b.organization_id,
      b.id            AS biz_id,
      b.legal_name,
      b.name          AS biz_name
    FROM public.businesses b
    WHERE b.is_active = true
    ORDER BY b.organization_id, b.created_at ASC
  ),
  biz_counts AS (
    SELECT bb.organization_id, COUNT(*)::int AS cnt
    FROM public.businesses bb
    WHERE bb.is_active = true
    GROUP BY bb.organization_id
  )
  SELECT
    o.id,
    o.name,
    pb.biz_id,
    COALESCE(pb.legal_name, pb.biz_name),
    COALESCE(bc.cnt, 0),
    CASE
      WHEN pb.biz_id IS NULL THEN 'no_primary_business'
      WHEN COALESCE(NULLIF(pb.legal_name, ''), pb.biz_name) IS DISTINCT FROM o.name
        THEN 'name_mismatch'
      WHEN COALESCE(bc.cnt, 0) > 1 THEN 'multi_business'
      ELSE NULL
    END
  FROM public.organizations o
  LEFT JOIN primary_biz pb ON pb.organization_id = o.id
  LEFT JOIN biz_counts bc ON bc.organization_id = o.id
  WHERE
    pb.biz_id IS NULL
    OR COALESCE(NULLIF(pb.legal_name, ''), pb.biz_name) IS DISTINCT FROM o.name
    OR COALESCE(bc.cnt, 0) > 1;
END;
$$;

CREATE OR REPLACE FUNCTION public.snapshot_identity_drift_report()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org RECORD;
  v_inserted int := 0;
BEGIN
  FOR v_org IN
    SELECT
      r.organization_id,
      jsonb_agg(
        jsonb_build_object(
          'kind', r.drift_kind,
          'org_name', r.org_name,
          'primary_business_id', r.primary_business_id,
          'primary_legal_name', r.primary_legal_name,
          'business_count', r.business_count
        )
      ) AS rows
    FROM public.run_identity_drift_check() r
    WHERE r.drift_kind IS NOT NULL
    GROUP BY r.organization_id
  LOOP
    INSERT INTO public.accounting_integrity_reports(
      organization_id,
      ar_drift,
      ap_drift,
      total_abs_drift,
      balance_drifts_count,
      has_drift,
      details,
      ran_at
    ) VALUES (
      v_org.organization_id,
      0, 0, 0,
      jsonb_array_length(v_org.rows),
      true,
      jsonb_build_object('identity_drift', v_org.rows),
      now()
    );
    v_inserted := v_inserted + 1;
  END LOOP;

  RETURN v_inserted;
END;
$$;

REVOKE ALL ON FUNCTION public.run_identity_drift_check() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.snapshot_identity_drift_report() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.run_identity_drift_check() TO authenticated;
GRANT EXECUTE ON FUNCTION public.snapshot_identity_drift_report() TO service_role;

DO $cron_block$
DECLARE
  v_jobid bigint;
BEGIN
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'snapshot_identity_drift_nightly';
  IF v_jobid IS NOT NULL THEN
    PERFORM cron.unschedule(v_jobid);
  END IF;

  PERFORM cron.schedule(
    'snapshot_identity_drift_nightly',
    '30 3 * * *',
    'SELECT public.snapshot_identity_drift_report();'
  );
EXCEPTION WHEN undefined_table THEN
  NULL;
END
$cron_block$;
