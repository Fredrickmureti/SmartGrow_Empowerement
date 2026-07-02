
CREATE TABLE IF NOT EXISTS public.pos_error_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  register_id uuid,
  shift_id uuid,
  kind text NOT NULL CHECK (kind IN (
    'render','rpc','hardware','network','validation','permission','unknown'
  )),
  severity text NOT NULL DEFAULT 'error' CHECK (severity IN ('warn','error','fatal')),
  message text,
  detail jsonb,
  user_agent text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pos_error_log_business_time
  ON public.pos_error_log (business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pos_error_log_register_time
  ON public.pos_error_log (register_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pos_error_log_kind
  ON public.pos_error_log (kind, created_at DESC);

ALTER TABLE public.pos_error_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "POS errors readable by business members"
  ON public.pos_error_log
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_business_access uba
      WHERE uba.business_id = pos_error_log.business_id
        AND uba.user_id = auth.uid()
    )
  );

-- No direct insert policy: writes must go through the SECURITY DEFINER RPC below.
-- This mirrors the pos_drawer_events architecture guard.

CREATE OR REPLACE FUNCTION public.log_pos_error(
  p_business_id uuid,
  p_kind text,
  p_message text DEFAULT NULL,
  p_detail jsonb DEFAULT NULL,
  p_register_id uuid DEFAULT NULL,
  p_shift_id uuid DEFAULT NULL,
  p_severity text DEFAULT 'error',
  p_user_agent text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_id uuid;
  v_user uuid := auth.uid();
  v_id uuid;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.user_business_access uba
    WHERE uba.business_id = p_business_id AND uba.user_id = v_user
  ) THEN
    RAISE EXCEPTION 'Forbidden: no access to business %', p_business_id USING ERRCODE = '42501';
  END IF;

  SELECT organization_id INTO v_org_id FROM public.businesses WHERE id = p_business_id;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'Unknown business %', p_business_id USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.pos_error_log (
    organization_id, business_id, register_id, shift_id,
    kind, severity, message, detail, user_agent, created_by
  ) VALUES (
    v_org_id, p_business_id, p_register_id, p_shift_id,
    COALESCE(p_kind, 'unknown'),
    COALESCE(p_severity, 'error'),
    p_message,
    p_detail,
    p_user_agent,
    v_user
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.log_pos_error(uuid, text, text, jsonb, uuid, uuid, text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.log_pos_error(uuid, text, text, jsonb, uuid, uuid, text, text) TO authenticated;
