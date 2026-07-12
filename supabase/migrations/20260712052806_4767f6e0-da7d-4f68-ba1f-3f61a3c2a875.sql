
CREATE OR REPLACE FUNCTION public.payroll_supersede_v1_certificates()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  affected integer := 0;
  is_admin boolean;
BEGIN
  -- Restrict to platform admins. Regular users must never mass-supersede.
  SELECT EXISTS (
    SELECT 1 FROM public.platform_admins pa
    WHERE pa.user_id = auth.uid()
      AND coalesce(pa.is_active, true) = true
  ) INTO is_admin;

  IF NOT is_admin THEN
    RAISE EXCEPTION 'payroll_supersede_v1_certificates requires platform admin'
      USING ERRCODE = '42501';
  END IF;

  WITH updated AS (
    UPDATE public.payroll_tax_certificates c
       SET stale        = true,
           stale_reason = 'renderer_v2',
           stale_at     = now()
     WHERE coalesce(c.stale, false) = false
       AND (
             c.provenance IS NULL
          OR c.provenance ? 'renderer' = false
          OR (c.provenance ->> 'renderer') = 'v1'
       )
    RETURNING c.id, c.organization_id
  ),
  events AS (
    INSERT INTO public.payroll_tax_certificate_events
      (certificate_id, event_type, metadata)
    SELECT
      u.id,
      'marked_stale',
      jsonb_build_object('reason', 'renderer_v2', 'source', 'payroll_supersede_v1_certificates')
    FROM updated u
    RETURNING 1
  )
  SELECT count(*)::int INTO affected FROM updated;

  RETURN affected;
END;
$$;

REVOKE ALL ON FUNCTION public.payroll_supersede_v1_certificates() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.payroll_supersede_v1_certificates() TO authenticated;
GRANT EXECUTE ON FUNCTION public.payroll_supersede_v1_certificates() TO service_role;

COMMENT ON FUNCTION public.payroll_supersede_v1_certificates() IS
  'ADR-0060 Phase F: bulk-mark v1-rendered tax certificates as stale so
   they are regenerated on the block-primitive renderer. Idempotent —
   new certificates carry provenance.renderer=v2 and are skipped.';
