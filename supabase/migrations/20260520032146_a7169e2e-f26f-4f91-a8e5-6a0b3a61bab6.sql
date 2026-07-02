
-- 1. scanner_device_labels
CREATE TABLE IF NOT EXISTS public.scanner_device_labels (
  session_id uuid NOT NULL,
  device_id text NOT NULL,
  label text NOT NULL,
  organization_id uuid NOT NULL,
  branch_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  PRIMARY KEY (session_id, device_id),
  CONSTRAINT scanner_device_labels_label_len CHECK (char_length(label) BETWEEN 1 AND 64),
  CONSTRAINT scanner_device_labels_device_len CHECK (char_length(device_id) BETWEEN 1 AND 128)
);

CREATE INDEX IF NOT EXISTS scanner_device_labels_session_idx
  ON public.scanner_device_labels (session_id);

ALTER TABLE public.scanner_device_labels ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS scanner_device_labels_select ON public.scanner_device_labels;
CREATE POLICY scanner_device_labels_select ON public.scanner_device_labels
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.organization_id = scanner_device_labels.organization_id
    )
    AND (
      scanner_device_labels.branch_id IS NULL
      OR public.user_can_access_branch(auth.uid(), scanner_device_labels.branch_id)
    )
  );

DROP POLICY IF EXISTS scanner_device_labels_no_direct_write ON public.scanner_device_labels;
CREATE POLICY scanner_device_labels_no_direct_write ON public.scanner_device_labels
  FOR INSERT TO authenticated WITH CHECK (false);

DROP POLICY IF EXISTS scanner_device_labels_no_direct_update ON public.scanner_device_labels;
CREATE POLICY scanner_device_labels_no_direct_update ON public.scanner_device_labels
  FOR UPDATE TO authenticated USING (false);

DROP POLICY IF EXISTS scanner_device_labels_no_direct_delete ON public.scanner_device_labels;
CREATE POLICY scanner_device_labels_no_direct_delete ON public.scanner_device_labels
  FOR DELETE TO authenticated USING (false);

-- 2. pos_rename_scanner_device RPC
CREATE OR REPLACE FUNCTION public.pos_rename_scanner_device(
  p_session uuid,
  p_device_id text,
  p_label text
) RETURNS public.scanner_device_labels
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid;
  v_branch uuid;
  v_label text;
  v_row public.scanner_device_labels;
  v_rate_count int;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;

  v_label := btrim(coalesce(p_label, ''));
  IF char_length(v_label) = 0 OR char_length(v_label) > 64 THEN
    RAISE EXCEPTION 'label must be 1..64 chars' USING ERRCODE = '22023';
  END IF;
  IF char_length(coalesce(p_device_id,'')) = 0 OR char_length(p_device_id) > 128 THEN
    RAISE EXCEPTION 'invalid device_id' USING ERRCODE = '22023';
  END IF;

  -- Resolve session scope. Try pos_registers first (registerId aliases session_id), then scanner_sessions.
  SELECT pr.organization_id, pr.branch_id INTO v_org, v_branch
  FROM public.pos_registers pr WHERE pr.id = p_session;

  IF v_org IS NULL THEN
    SELECT ss.organization_id, ss.branch_id INTO v_org, v_branch
    FROM public.scanner_sessions ss WHERE ss.id = p_session;
  END IF;

  IF v_org IS NULL THEN
    RAISE EXCEPTION 'session not found' USING ERRCODE = '42704';
  END IF;

  -- Caller must belong to the org.
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = auth.uid() AND ur.organization_id = v_org
  ) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF v_branch IS NOT NULL AND NOT public.user_can_access_branch(auth.uid(), v_branch) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  -- Rate limit: 10 renames/min/device via existing scan_events_rate.
  INSERT INTO public.scan_events_rate (device_id, minute_bucket, count)
  VALUES ('rename:' || p_device_id, date_trunc('minute', now()), 1)
  ON CONFLICT (device_id, minute_bucket)
    DO UPDATE SET count = scan_events_rate.count + 1
  RETURNING count INTO v_rate_count;

  IF v_rate_count > 10 THEN
    RAISE EXCEPTION 'rate_limited' USING ERRCODE = '54000';
  END IF;

  INSERT INTO public.scanner_device_labels (
    session_id, device_id, label, organization_id, branch_id, updated_at, updated_by
  ) VALUES (
    p_session, p_device_id, v_label, v_org, v_branch, now(), auth.uid()
  )
  ON CONFLICT (session_id, device_id)
    DO UPDATE SET label = excluded.label,
                  updated_at = now(),
                  updated_by = excluded.updated_by
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.pos_rename_scanner_device(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pos_rename_scanner_device(uuid, text, text) TO authenticated;

-- 3. list_scan_events viewer (security-invoker; respects scan_events RLS)
CREATE OR REPLACE FUNCTION public.list_scan_events(
  p_limit int DEFAULT 200,
  p_register uuid DEFAULT NULL,
  p_verdict text DEFAULT NULL
) RETURNS TABLE (
  id uuid,
  received_at timestamptz,
  decoded_at timestamptz,
  register_id uuid,
  session_id uuid,
  device_id text,
  source text,
  code_masked text,
  verdict text,
  workflow text,
  latency_ms int
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    se.id,
    se.received_at,
    se.decoded_at,
    se.register_id,
    se.session_id,
    se.device_id,
    se.source,
    CASE
      WHEN se.code IS NULL THEN NULL
      WHEN char_length(se.code) <= 4 THEN se.code
      ELSE substr(se.code, 1, 4) || repeat('•', greatest(0, char_length(se.code) - 4))
    END AS code_masked,
    se.verdict,
    se.workflow,
    se.latency_ms
  FROM public.scan_events se
  WHERE (p_register IS NULL OR se.register_id = p_register)
    AND (p_verdict IS NULL OR se.verdict = p_verdict)
  ORDER BY se.received_at DESC
  LIMIT LEAST(GREATEST(coalesce(p_limit, 200), 1), 500);
$$;

REVOKE ALL ON FUNCTION public.list_scan_events(int, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_scan_events(int, uuid, text) TO authenticated;
