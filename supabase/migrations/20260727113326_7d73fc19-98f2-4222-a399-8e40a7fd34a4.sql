
-- ============================================================
-- Wave 6.1 — Tables
-- ============================================================
CREATE TABLE public.printer_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  code text NOT NULL,
  label text NOT NULL,
  hardware_kind text NOT NULL,
  default_media_class text,
  description text,
  is_active boolean NOT NULL DEFAULT true,
  is_system boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code)
);

GRANT SELECT ON public.printer_roles TO authenticated;
GRANT ALL    ON public.printer_roles TO service_role;
ALTER TABLE public.printer_roles ENABLE ROW LEVEL SECURITY;

CREATE POLICY printer_roles_org_read ON public.printer_roles
  FOR SELECT TO authenticated
  USING (public.is_org_member(auth.uid(), organization_id));

CREATE TRIGGER printer_roles_touch
  BEFORE UPDATE ON public.printer_roles
  FOR EACH ROW EXECUTE FUNCTION public._set_updated_at();

CREATE TABLE public.printer_role_branch_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES public.branches(id) ON DELETE CASCADE,
  role_id uuid NOT NULL REFERENCES public.printer_roles(id) ON DELETE CASCADE,
  device_assignment_id uuid NOT NULL REFERENCES public.device_assignments(id) ON DELETE CASCADE,
  is_primary boolean NOT NULL DEFAULT true,
  priority int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (branch_id, role_id, device_assignment_id)
);

CREATE INDEX printer_role_branch_bindings_lookup
  ON public.printer_role_branch_bindings (branch_id, role_id, is_primary DESC, priority ASC);

GRANT SELECT ON public.printer_role_branch_bindings TO authenticated;
GRANT ALL    ON public.printer_role_branch_bindings TO service_role;
ALTER TABLE public.printer_role_branch_bindings ENABLE ROW LEVEL SECURITY;

CREATE POLICY printer_role_bindings_org_read ON public.printer_role_branch_bindings
  FOR SELECT TO authenticated
  USING (public.is_org_member(auth.uid(), organization_id));

CREATE TRIGGER printer_role_bindings_touch
  BEFORE UPDATE ON public.printer_role_branch_bindings
  FOR EACH ROW EXECUTE FUNCTION public._set_updated_at();

-- ============================================================
-- Wave 6.2 — print_jobs retry / DLQ columns
-- ============================================================
ALTER TABLE public.print_jobs
  ADD COLUMN dedupe_key      text,
  ADD COLUMN max_attempts    int  NOT NULL DEFAULT 5,
  ADD COLUMN next_attempt_at timestamptz,
  ADD COLUMN requeued_count  int  NOT NULL DEFAULT 0,
  ADD COLUMN processing_at   timestamptz;

CREATE UNIQUE INDEX print_jobs_dedupe_active
  ON public.print_jobs (business_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL
    AND status IN ('queued', 'processing');

CREATE INDEX print_jobs_ready_for_claim
  ON public.print_jobs (created_at)
  WHERE status = 'queued';

-- ============================================================
-- Wave 6.3 — RPCs
-- ============================================================

-- Role → device fallback list, ordered by primary then priority.
-- Returns online devices first; then any online-or-unknown; empty when nothing bound.
CREATE OR REPLACE FUNCTION public.resolve_hardware_assignment(
  p_organization_id uuid,
  p_branch_id uuid,
  p_role_code text
) RETURNS TABLE(
  device_assignment_id uuid,
  is_primary boolean,
  priority int,
  device_status text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT
    da.id AS device_assignment_id,
    b.is_primary,
    b.priority,
    da.status AS device_status
  FROM public.printer_role_branch_bindings b
  JOIN public.printer_roles r ON r.id = b.role_id
  JOIN public.device_assignments da ON da.id = b.device_assignment_id
  WHERE r.organization_id = p_organization_id
    AND b.branch_id       = p_branch_id
    AND r.code            = p_role_code
    AND r.is_active       = true
    AND da.enabled        = true
  ORDER BY
    CASE WHEN da.status = 'online' THEN 0 ELSE 1 END,
    b.is_primary DESC,
    b.priority   ASC,
    b.created_at ASC;
$$;

REVOKE ALL ON FUNCTION public.resolve_hardware_assignment(uuid, uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.resolve_hardware_assignment(uuid, uuid, text) TO authenticated, service_role;

-- Atomic batch claim for the dispatcher. Service-role only.
CREATE OR REPLACE FUNCTION public.claim_print_jobs(p_batch_size int DEFAULT 25)
RETURNS SETOF public.print_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  UPDATE public.print_jobs pj
     SET status        = 'processing',
         processing_at = now(),
         attempt_count = pj.attempt_count + 1,
         updated_at    = now()
    FROM (
      SELECT id
        FROM public.print_jobs
       WHERE status = 'queued'
         AND (next_attempt_at IS NULL OR next_attempt_at <= now())
       ORDER BY created_at ASC
       LIMIT GREATEST(p_batch_size, 1)
       FOR UPDATE SKIP LOCKED
    ) claimed
   WHERE pj.id = claimed.id
  RETURNING pj.*;
END $$;

REVOKE ALL ON FUNCTION public.claim_print_jobs(int) FROM public, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_print_jobs(int) TO service_role;

-- Requeue a failed / dead-letter job. Platform admin only.
CREATE OR REPLACE FUNCTION public.requeue_print_job(p_job_id uuid)
RETURNS public.print_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_row public.print_jobs%ROWTYPE;
BEGIN
  IF auth.role() <> 'service_role'
     AND NOT public.is_platform_admin(auth.uid()) THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;

  UPDATE public.print_jobs
     SET status          = 'queued',
         next_attempt_at = NULL,
         processing_at   = NULL,
         last_error      = NULL,
         requeued_count  = requeued_count + 1,
         updated_at      = now()
   WHERE id = p_job_id
     AND status IN ('failed', 'dead_letter', 'abandoned')
  RETURNING * INTO v_row;

  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'job_not_requeueable' USING ERRCODE = 'P0002';
  END IF;

  RETURN v_row;
END $$;

REVOKE ALL ON FUNCTION public.requeue_print_job(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.requeue_print_job(uuid) TO authenticated, service_role;

-- Replace mark_print_job_failed with back-off + dead-letter.
CREATE OR REPLACE FUNCTION public.mark_print_job_failed(p_job_id uuid, p_error text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_attempts int;
  v_max      int;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;

  SELECT attempt_count, max_attempts INTO v_attempts, v_max
    FROM public.print_jobs WHERE id = p_job_id;

  IF v_attempts IS NULL THEN
    RETURN;
  END IF;

  IF v_attempts >= COALESCE(v_max, 5) THEN
    UPDATE public.print_jobs
       SET status          = 'dead_letter',
           failed_at       = now(),
           last_error      = p_error,
           next_attempt_at = NULL,
           updated_at      = now()
     WHERE id = p_job_id;
  ELSE
    UPDATE public.print_jobs
       SET status          = 'queued',
           failed_at       = now(),
           last_error      = p_error,
           next_attempt_at = now() + (power(2, LEAST(v_attempts, 8))::text || ' seconds')::interval,
           processing_at   = NULL,
           updated_at      = now()
     WHERE id = p_job_id;
  END IF;
END $$;

REVOKE ALL ON FUNCTION public.mark_print_job_failed(uuid, text) FROM public, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_print_job_failed(uuid, text) TO service_role;

-- Update submit_document_intent to populate dedupe_key.
CREATE OR REPLACE FUNCTION public.submit_document_intent(
  p_document_record_id uuid,
  p_scenario text DEFAULT 'default',
  p_triggered_source text DEFAULT 'api',
  p_override_targets jsonb DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_doc         public.document_records%ROWTYPE;
  v_plan        jsonb;
  v_intent_id   uuid;
  v_targets     jsonb;
  v_target      jsonb;
  v_job_id      uuid;
  v_job_ids     uuid[] := ARRAY[]::uuid[];
  v_correlation text;
  v_target_id   uuid;
  v_dedupe      text;
BEGIN
  SELECT * INTO v_doc FROM public.document_records WHERE id = p_document_record_id;
  IF v_doc.id IS NULL THEN
    RAISE EXCEPTION 'document_record_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF auth.role() <> 'service_role'
     AND NOT public.is_org_member(auth.uid(), v_doc.organization_id) THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;

  IF p_override_targets IS NOT NULL THEN
    v_intent_id := NULL;
    v_targets   := p_override_targets;
  ELSE
    v_plan := public.resolve_output_intent(
      v_doc.kind_code, v_doc.organization_id, v_doc.branch_id, p_scenario
    );
    IF NOT COALESCE((v_plan->>'resolved')::boolean, false) THEN
      RAISE EXCEPTION 'no_output_intent_matched (%, %)', v_doc.kind_code, p_scenario;
    END IF;
    v_intent_id := (v_plan->>'intent_id')::uuid;
    v_targets   := COALESCE(v_plan->'targets', '[]'::jsonb);
  END IF;

  FOR v_target IN SELECT * FROM jsonb_array_elements(v_targets)
  LOOP
    v_target_id   := (v_target->>'id')::uuid;
    v_correlation := encode(gen_random_bytes(12), 'hex');
    v_dedupe      := v_doc.id::text
                  || ':' || COALESCE(v_target_id::text, v_target->>'medium' || ':' || COALESCE(v_target->>'disposition',''))
                  || ':' || p_scenario
                  || ':' || COALESCE(v_doc.version::text, '1');

    INSERT INTO public.print_jobs (
      business_id, branch_id,
      doc_type, doc_id,
      intent, format,
      correlation_id, transport, status,
      document_record_id, output_intent_id, output_intent_target_id,
      disposition, medium, hardware_role, copies,
      scenario, triggered_source, render_params, requested_by,
      dedupe_key
    ) VALUES (
      COALESCE(v_doc.business_id, v_doc.organization_id),
      v_doc.branch_id,
      v_doc.kind_code, v_doc.id,
      COALESCE(v_target->>'disposition', 'print'),
      COALESCE(v_target->>'medium', 'pdf'),
      v_correlation,
      COALESCE(v_target->>'hardware_role', 'virtual'),
      'queued',
      v_doc.id, v_intent_id, v_target_id,
      (v_target->>'disposition')::public.output_disposition,
      (v_target->>'medium')::public.output_medium,
      v_target->>'hardware_role',
      COALESCE((v_target->>'copies')::smallint, 1),
      p_scenario, p_triggered_source,
      COALESCE(v_target->'params', '{}'::jsonb),
      CASE WHEN auth.role() = 'service_role' THEN NULL ELSE auth.uid() END,
      v_dedupe
    )
    ON CONFLICT (business_id, dedupe_key)
      WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'processing')
      DO NOTHING
    RETURNING id INTO v_job_id;

    IF v_job_id IS NOT NULL THEN
      v_job_ids := v_job_ids || v_job_id;
    END IF;
  END LOOP;

  INSERT INTO public.output_dispatch_log (
    document_id, document_kind, organization_id, branch_id, scenario,
    intent_id, resolved_targets, triggered_by, triggered_source, status
  ) VALUES (
    v_doc.id, v_doc.kind_code, v_doc.organization_id, v_doc.branch_id, p_scenario,
    v_intent_id, v_targets,
    CASE WHEN auth.role() = 'service_role' THEN NULL ELSE auth.uid() END,
    p_triggered_source,
    CASE WHEN array_length(v_job_ids, 1) > 0 THEN 'dispatched' ELSE 'resolved' END
  );

  RETURN jsonb_build_object(
    'document_record_id', v_doc.id,
    'intent_id',   v_intent_id,
    'scenario',    p_scenario,
    'job_ids',     to_jsonb(v_job_ids),
    'target_count', COALESCE(jsonb_array_length(v_targets), 0)
  );
END $$;

-- ============================================================
-- Wave 6.4 — Bootstrap trigger + backfill
-- ============================================================
CREATE OR REPLACE FUNCTION public._seed_default_printer_roles(p_organization_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  INSERT INTO public.printer_roles
    (organization_id, code, label, hardware_kind, default_media_class, is_system, description)
  VALUES
    (p_organization_id, 'receipt_thermal', 'Receipt Printer (Thermal)',
     'receipt_printer', 'thermal_80', true,
     'Customer / merchant receipts printed on 58 or 80 mm thermal rolls.'),
    (p_organization_id, 'fiscal_a4', 'Fiscal / Legal Documents (A4)',
     'a4_printer', 'a4', true,
     'Tax invoices, credit notes, statements, statutory returns.'),
    (p_organization_id, 'label_zpl', 'Label Printer (ZPL)',
     'label_printer', 'label_50x30', true,
     'Product, shelf, and shipping labels rendered as ZPL.'),
    (p_organization_id, 'kitchen', 'Kitchen / Bar Printer',
     'kitchen_printer', 'thermal_80', true,
     'POS kitchen and bar tickets — one printer per station.'),
    (p_organization_id, 'back_office', 'Back Office (A4)',
     'a4_printer', 'a4', true,
     'Reports, journals, HR letters, non-fiscal PDF output.')
  ON CONFLICT (organization_id, code) DO NOTHING;
$$;

CREATE OR REPLACE FUNCTION public._bootstrap_printer_roles()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  PERFORM public._seed_default_printer_roles(NEW.id);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS bootstrap_printer_roles ON public.organizations;
CREATE TRIGGER bootstrap_printer_roles
  AFTER INSERT ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION public._bootstrap_printer_roles();

-- Backfill for existing orgs.
DO $$
DECLARE
  v_org uuid;
BEGIN
  FOR v_org IN SELECT id FROM public.organizations LOOP
    PERFORM public._seed_default_printer_roles(v_org);
  END LOOP;
END $$;
