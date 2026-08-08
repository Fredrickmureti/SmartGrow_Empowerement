-- ── 1. Explicit lifecycle state ─────────────────────────────────────────
ALTER TABLE public.recurring_invoices
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS status_changed_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS definition_version integer NOT NULL DEFAULT 1;

UPDATE public.recurring_invoices
   SET status = CASE
     WHEN completed_at IS NOT NULL THEN 'completed'
     WHEN is_active THEN 'active'
     ELSE 'paused' END;

ALTER TABLE public.recurring_invoices
  DROP CONSTRAINT IF EXISTS recurring_invoices_status_check;
ALTER TABLE public.recurring_invoices
  ADD CONSTRAINT recurring_invoices_status_check
  CHECK (status = ANY (ARRAY['active','paused','cancelled','completed']));

ALTER TABLE public.recurring_invoice_runs
  ADD COLUMN IF NOT EXISTS definition_version integer;

-- ── 2. Amendment versions ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.recurring_invoice_definition_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recurring_invoice_id uuid NOT NULL REFERENCES public.recurring_invoices(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL,
  business_id uuid,
  version integer NOT NULL,
  snapshot jsonb NOT NULL,
  changed_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (recurring_invoice_id, version)
);

GRANT SELECT ON public.recurring_invoice_definition_versions TO authenticated;
GRANT ALL ON public.recurring_invoice_definition_versions TO service_role;
ALTER TABLE public.recurring_invoice_definition_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Members read recurring definition versions"
  ON public.recurring_invoice_definition_versions FOR SELECT TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id)
         OR business_id IS NULL AND public.is_org_member(auth.uid(), organization_id));

-- ── 3. Status history ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.recurring_invoice_status_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recurring_invoice_id uuid NOT NULL REFERENCES public.recurring_invoices(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL,
  business_id uuid,
  from_status text,
  to_status text NOT NULL,
  reason text,
  changed_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.recurring_invoice_status_events TO authenticated;
GRANT ALL ON public.recurring_invoice_status_events TO service_role;
ALTER TABLE public.recurring_invoice_status_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Members read recurring status events"
  ON public.recurring_invoice_status_events FOR SELECT TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id)
         OR business_id IS NULL AND public.is_org_member(auth.uid(), organization_id));

-- ── 4. Single writer for the lifecycle ──────────────────────────────────
CREATE OR REPLACE FUNCTION public._recurring_status_write_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND COALESCE(current_setting('app.recurring_status_writer', true), '') <> NEW.id::text THEN
    RAISE EXCEPTION 'recurring_invoices.status is owned by set_recurring_status_atomic'
      USING ERRCODE = '42501';
  END IF;
  -- The legacy boolean is derived, never independently authored.
  NEW.is_active := (NEW.status = 'active');
  NEW.completed_at := CASE WHEN NEW.status = 'completed'
                           THEN COALESCE(NEW.completed_at, now()) ELSE NULL END;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.status_changed_at := now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_recurring_status_write_guard ON public.recurring_invoices;
CREATE TRIGGER trg_recurring_status_write_guard
  BEFORE UPDATE ON public.recurring_invoices
  FOR EACH ROW EXECUTE FUNCTION public._recurring_status_write_guard();

CREATE OR REPLACE FUNCTION public.set_recurring_status_atomic(
  p_recurring_id uuid, p_status text, p_user_id uuid DEFAULT NULL, p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_ri record; v_allowed text[];
BEGIN
  SELECT * INTO v_ri FROM public.recurring_invoices WHERE id = p_recurring_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Recurring template % not found', p_recurring_id; END IF;

  IF p_user_id IS NOT NULL AND auth.uid() IS NOT NULL
     AND NOT public.user_can_access_business(p_user_id, v_ri.business_id) THEN
    RAISE EXCEPTION 'Access denied for business %', v_ri.business_id USING ERRCODE = '42501';
  END IF;

  v_allowed := CASE v_ri.status
    WHEN 'active'    THEN ARRAY['paused','cancelled','completed']
    WHEN 'paused'    THEN ARRAY['active','cancelled']
    WHEN 'completed' THEN ARRAY[]::text[]
    WHEN 'cancelled' THEN ARRAY[]::text[]
    ELSE ARRAY[]::text[] END;

  IF v_ri.status = p_status THEN
    RETURN jsonb_build_object('status', p_status, 'changed', false);
  END IF;
  IF NOT (p_status = ANY (v_allowed)) THEN
    RAISE EXCEPTION 'Illegal recurring template transition % → %', v_ri.status, p_status;
  END IF;

  PERFORM set_config('app.recurring_status_writer', p_recurring_id::text, true);
  UPDATE public.recurring_invoices
     SET status = p_status, updated_at = now()
   WHERE id = p_recurring_id;
  PERFORM set_config('app.recurring_status_writer', '', true);

  INSERT INTO public.recurring_invoice_status_events (
    recurring_invoice_id, organization_id, business_id, from_status, to_status, reason, changed_by)
  VALUES (p_recurring_id, v_ri.organization_id, v_ri.business_id, v_ri.status, p_status, p_reason, p_user_id);

  RETURN jsonb_build_object('status', p_status, 'changed', true, 'from', v_ri.status);
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_recurring_status_atomic(uuid, text, uuid, text) TO authenticated, service_role;

-- ── 5. Amendment versioning triggers ────────────────────────────────────
CREATE OR REPLACE FUNCTION public._recurring_bump_definition_version(_recurring_id uuid, _user_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_ri record; v_version integer;
BEGIN
  SELECT * INTO v_ri FROM public.recurring_invoices WHERE id = _recurring_id;
  IF NOT FOUND THEN RETURN; END IF;
  v_version := COALESCE(v_ri.definition_version, 1);

  INSERT INTO public.recurring_invoice_definition_versions (
    recurring_invoice_id, organization_id, business_id, version, snapshot, changed_by)
  VALUES (
    _recurring_id, v_ri.organization_id, v_ri.business_id, v_version,
    jsonb_build_object(
      'template_name', v_ri.template_name,
      'contact_id', v_ri.contact_id,
      'frequency', v_ri.frequency,
      'currency', v_ri.currency,
      'days_before_due', v_ri.days_before_due,
      'auto_confirm', v_ri.auto_confirm,
      'auto_send', v_ri.auto_send,
      'start_date', v_ri.start_date,
      'end_date', v_ri.end_date,
      'items', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
                 'product_id', i.product_id, 'description', i.description,
                 'quantity', i.quantity, 'unit_price', i.unit_price,
                 'tax_rate', i.tax_rate, 'discount_percent', i.discount_percent,
                 'sort_order', i.sort_order) ORDER BY i.sort_order)
          FROM public.recurring_invoice_items i
         WHERE i.recurring_invoice_id = _recurring_id), '[]'::jsonb)),
    _user_id)
  ON CONFLICT (recurring_invoice_id, version) DO UPDATE
    SET snapshot = EXCLUDED.snapshot, changed_by = EXCLUDED.changed_by, created_at = now();
END;
$$;

CREATE OR REPLACE FUNCTION public._recurring_items_version_trigger()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_id uuid := COALESCE(NEW.recurring_invoice_id, OLD.recurring_invoice_id);
BEGIN
  UPDATE public.recurring_invoices
     SET definition_version = COALESCE(definition_version, 1) + 1, updated_at = now()
   WHERE id = v_id;
  PERFORM public._recurring_bump_definition_version(v_id, auth.uid());
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_recurring_items_version ON public.recurring_invoice_items;
CREATE TRIGGER trg_recurring_items_version
  AFTER INSERT OR UPDATE OR DELETE ON public.recurring_invoice_items
  FOR EACH ROW EXECUTE FUNCTION public._recurring_items_version_trigger();

-- Seed a version-1 snapshot for every existing template.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT id FROM public.recurring_invoices LOOP
    PERFORM public._recurring_bump_definition_version(r.id, NULL);
  END LOOP;
END $$;

-- ── 6. Engine: stamp the version, complete through the state machine ────
CREATE OR REPLACE FUNCTION public._recurring_complete_if_finished(_recurring_id uuid, _next_start date)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_end date; v_status text;
BEGIN
  SELECT end_date, status INTO v_end, v_status FROM public.recurring_invoices WHERE id = _recurring_id;
  IF v_end IS NOT NULL AND _next_start > v_end AND v_status = 'active' THEN
    PERFORM public.set_recurring_status_atomic(
      _recurring_id, 'completed', NULL, 'Schedule reached its end date');
  END IF;
END;
$$;
GRANT EXECUTE ON FUNCTION public._recurring_complete_if_finished(uuid, date) TO service_role;