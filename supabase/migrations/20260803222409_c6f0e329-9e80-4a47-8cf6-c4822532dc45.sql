-- ═══════════════════════════════════════════════════════════════════
-- 3PL billing — Phase 6: dispute + reversal (no edits, ever)
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE public.wms_billable_activities
  ADD COLUMN IF NOT EXISTS disputed_at          timestamptz NULL,
  ADD COLUMN IF NOT EXISTS dispute_reason       text NULL,
  ADD COLUMN IF NOT EXISTS disputed_by          uuid NULL,
  ADD COLUMN IF NOT EXISTS dispute_resolved_at  timestamptz NULL,
  ADD COLUMN IF NOT EXISTS dispute_resolution   text NULL,
  ADD COLUMN IF NOT EXISTS reverses_activity_id uuid NULL
    REFERENCES public.wms_billable_activities(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_wms_billable_disputed
  ON public.wms_billable_activities (business_id, client_id)
  WHERE disputed_at IS NOT NULL AND dispute_resolved_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_wms_billable_reversal
  ON public.wms_billable_activities (reverses_activity_id)
  WHERE reverses_activity_id IS NOT NULL;

-- Immutability trigger now also permits the sanctioned dispute columns.
CREATE OR REPLACE FUNCTION public._wms_billable_activities_immutable()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $function$
DECLARE
  v_allowed text[] := ARRAY['invoice_id','disputed_at','dispute_reason',
                            'disputed_by','dispute_resolved_at','dispute_resolution'];
  v_old jsonb := to_jsonb(OLD);
  v_new jsonb := to_jsonb(NEW);
  k text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'wms_billable_activities is an immutable ledger; post a reversing entry instead';
  END IF;

  FOREACH k IN ARRAY v_allowed LOOP
    v_old := v_old - k;
    v_new := v_new - k;
  END LOOP;

  IF v_old IS DISTINCT FROM v_new THEN
    RAISE EXCEPTION
      'wms_billable_activities is an immutable ledger; only invoice and dispute state may change';
  END IF;

  IF NEW.disputed_at IS DISTINCT FROM OLD.disputed_at
     AND current_setting('wms.billing_writer', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'dispute state may only change through wms_dispute_billable_activity';
  END IF;

  RETURN NEW;
END; $function$;

-- ── Dispute / resolve ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.wms_dispute_billable_activity(
  p_activity_id uuid,
  p_reason      text,
  p_resolve     boolean DEFAULT false,
  p_resolution  text DEFAULT NULL
) RETURNS public.wms_billable_activities
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $function$
DECLARE
  v_row public.wms_billable_activities;
BEGIN
  SELECT * INTO v_row FROM public.wms_billable_activities WHERE id = p_activity_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'activity not found'; END IF;
  IF NOT public.user_can_access_business(auth.uid(), v_row.business_id) THEN
    RAISE EXCEPTION 'access denied';
  END IF;
  IF NOT public.user_has_module_permission(auth.uid(), v_row.business_id, 'inventory', 'write') THEN
    RAISE EXCEPTION 'access denied';
  END IF;

  PERFORM set_config('wms.billing_writer', 'on', true);

  IF p_resolve THEN
    IF v_row.disputed_at IS NULL THEN RAISE EXCEPTION 'activity is not disputed'; END IF;
    UPDATE public.wms_billable_activities
       SET dispute_resolved_at = now(),
           dispute_resolution  = COALESCE(p_resolution, p_reason)
     WHERE id = p_activity_id
     RETURNING * INTO v_row;
  ELSE
    IF COALESCE(btrim(p_reason), '') = '' THEN
      RAISE EXCEPTION 'a dispute reason is required';
    END IF;
    UPDATE public.wms_billable_activities
       SET disputed_at        = now(),
           dispute_reason     = p_reason,
           disputed_by        = auth.uid(),
           dispute_resolved_at = NULL,
           dispute_resolution  = NULL
     WHERE id = p_activity_id
     RETURNING * INTO v_row;
  END IF;

  PERFORM set_config('wms.billing_writer', 'off', true);
  RETURN v_row;
END; $function$;

-- ── Reversal: a new negative row, never an edit ─────────────────────
CREATE OR REPLACE FUNCTION public.wms_reverse_billable_activity(
  p_activity_id uuid,
  p_reason      text
) RETURNS public.wms_billable_activities
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $function$
DECLARE
  v_src public.wms_billable_activities;
  v_row public.wms_billable_activities;
BEGIN
  SELECT * INTO v_src FROM public.wms_billable_activities WHERE id = p_activity_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'activity not found'; END IF;
  IF NOT public.user_can_access_business(auth.uid(), v_src.business_id) THEN
    RAISE EXCEPTION 'access denied';
  END IF;
  IF NOT public.user_has_module_permission(auth.uid(), v_src.business_id, 'inventory', 'write') THEN
    RAISE EXCEPTION 'access denied';
  END IF;
  IF v_src.reverses_activity_id IS NOT NULL THEN
    RAISE EXCEPTION 'a reversal cannot itself be reversed';
  END IF;
  IF EXISTS (SELECT 1 FROM public.wms_billable_activities
              WHERE reverses_activity_id = p_activity_id) THEN
    RAISE EXCEPTION 'this activity has already been reversed';
  END IF;
  IF COALESCE(btrim(p_reason), '') = '' THEN
    RAISE EXCEPTION 'a reversal reason is required';
  END IF;

  PERFORM public._wms_assert_period_open(v_src.business_id, CURRENT_DATE);

  INSERT INTO public.wms_billable_activities (
    business_id, client_id, client_business_id, warehouse_id, activity, uom,
    quantity, occurred_at, source_event_id, source_doc_type, source_doc_id,
    tariff_id, unit_rate, currency, amount, reverses_activity_id, dispute_reason
  ) VALUES (
    v_src.business_id, v_src.client_id, v_src.client_business_id, v_src.warehouse_id,
    v_src.activity, v_src.uom,
    -v_src.quantity, now(), NULL, 'wms_billing_reversal', v_src.id,
    v_src.tariff_id, v_src.unit_rate, v_src.currency,
    CASE WHEN v_src.amount IS NULL THEN NULL ELSE -v_src.amount END,
    v_src.id, p_reason
  ) RETURNING * INTO v_row;

  RETURN v_row;
END; $function$;

REVOKE ALL ON FUNCTION public.wms_dispute_billable_activity(uuid, text, boolean, text) FROM public;
GRANT EXECUTE ON FUNCTION public.wms_dispute_billable_activity(uuid, text, boolean, text)
  TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.wms_reverse_billable_activity(uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.wms_reverse_billable_activity(uuid, text)
  TO authenticated, service_role;

COMMENT ON COLUMN public.wms_billable_activities.reverses_activity_id IS
  'Set on a negative correction row; the original stays untouched. If the original was already invoiced, the reversal is picked up as a credit line on the next invoice.';
