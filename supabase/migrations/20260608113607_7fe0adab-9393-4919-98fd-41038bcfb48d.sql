
-- 1) Saved views table
CREATE TABLE IF NOT EXISTS public.attendance_saved_views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  business_id uuid,
  scope text NOT NULL CHECK (scope IN ('today','approvals','reports')),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  filters jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS attendance_saved_views_user_scope_idx
  ON public.attendance_saved_views(user_id, scope);

-- Only one default per (user, scope, business)
CREATE UNIQUE INDEX IF NOT EXISTS attendance_saved_views_one_default
  ON public.attendance_saved_views(user_id, scope, coalesce(business_id::text,''))
  WHERE is_default;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.attendance_saved_views TO authenticated;
GRANT ALL ON public.attendance_saved_views TO service_role;

ALTER TABLE public.attendance_saved_views ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "own saved views select" ON public.attendance_saved_views;
DROP POLICY IF EXISTS "own saved views write" ON public.attendance_saved_views;
CREATE POLICY "own saved views select" ON public.attendance_saved_views
  FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY "own saved views write" ON public.attendance_saved_views
  FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

CREATE OR REPLACE FUNCTION public._asv_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS attendance_saved_views_updated_at ON public.attendance_saved_views;
CREATE TRIGGER attendance_saved_views_updated_at
  BEFORE UPDATE ON public.attendance_saved_views
  FOR EACH ROW EXECUTE FUNCTION public._asv_touch_updated_at();

-- 2) Anomaly acknowledgement
ALTER TABLE public.attendance
  ADD COLUMN IF NOT EXISTS anomaly_ack_codes text[] NOT NULL DEFAULT '{}'::text[];

CREATE OR REPLACE FUNCTION public.attendance_anomaly_ack(
  _attendance_id uuid,
  _codes text[]
) RETURNS public.attendance
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.attendance;
  v_org uuid;
  v_biz uuid;
  v_ok boolean;
BEGIN
  IF _attendance_id IS NULL OR _codes IS NULL OR array_length(_codes, 1) IS NULL THEN
    RAISE EXCEPTION 'INVALID_INPUT';
  END IF;

  SELECT organization_id, business_id INTO v_org, v_biz
    FROM public.attendance WHERE id = _attendance_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'ATTENDANCE_NOT_FOUND';
  END IF;

  -- Permission gate: needs attendance.write in this org
  SELECT public.user_has_module_permission(auth.uid(), v_org, 'attendance', 'write')
    INTO v_ok;
  IF NOT coalesce(v_ok, false) THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;

  UPDATE public.attendance
     SET anomaly_ack_codes = (
       SELECT array(SELECT DISTINCT unnest(coalesce(anomaly_ack_codes,'{}'::text[]) || _codes))
     ),
     updated_at = now()
   WHERE id = _attendance_id
   RETURNING * INTO v_row;

  -- Append-only event log (best-effort; ignore if helper signature drifts)
  BEGIN
    PERFORM public.attendance_log_event(
      _attendance_id := _attendance_id,
      _employee_id := v_row.employee_id,
      _event_type := 'ANOMALY_ACK',
      _outcome := 'allow',
      _metadata := jsonb_build_object('codes', _codes)
    );
  EXCEPTION WHEN undefined_function THEN
    NULL;
  END;

  RETURN v_row;
END $$;

GRANT EXECUTE ON FUNCTION public.attendance_anomaly_ack(uuid, text[]) TO authenticated;
