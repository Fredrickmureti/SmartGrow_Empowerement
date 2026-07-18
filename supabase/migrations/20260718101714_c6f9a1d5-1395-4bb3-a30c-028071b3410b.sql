
CREATE TABLE public.sourcing_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL, business_id uuid NOT NULL, branch_id uuid,
  event_number text NOT NULL, title text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('rfi','rfq','rfp','auction')),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','open','evaluating','awarded','closed','cancelled')),
  sealed_bid boolean NOT NULL DEFAULT false,
  currency text NOT NULL DEFAULT 'USD',
  opens_at timestamptz, closes_at timestamptz, target_ceiling_value numeric,
  requisition_id uuid REFERENCES public.purchase_requisitions(id) ON DELETE SET NULL,
  contract_id uuid REFERENCES public.procurement_contracts(id) ON DELETE SET NULL,
  award_justification text, notes text,
  created_by uuid NOT NULL,
  opened_by uuid, opened_at timestamptz,
  closed_by uuid, closed_at timestamptz,
  awarded_by uuid, awarded_at timestamptz,
  cancelled_by uuid, cancelled_at timestamptz, cancelled_reason text,
  is_sample_data boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, event_number),
  CHECK (closes_at IS NULL OR opens_at IS NULL OR closes_at > opens_at)
);
CREATE INDEX idx_sourcing_events_biz_status ON public.sourcing_events(business_id, status);
CREATE INDEX idx_sourcing_events_req ON public.sourcing_events(requisition_id) WHERE requisition_id IS NOT NULL;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sourcing_events TO authenticated;
GRANT ALL ON public.sourcing_events TO service_role;
ALTER TABLE public.sourcing_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "sourcing_events select" ON public.sourcing_events FOR SELECT TO authenticated USING (public.user_has_business_access(auth.uid(), business_id));
CREATE POLICY "sourcing_events insert" ON public.sourcing_events FOR INSERT TO authenticated WITH CHECK (public.user_has_business_access(auth.uid(), business_id));
CREATE POLICY "sourcing_events update" ON public.sourcing_events FOR UPDATE TO authenticated USING (public.user_has_business_access(auth.uid(), business_id)) WITH CHECK (public.user_has_business_access(auth.uid(), business_id));
CREATE POLICY "sourcing_events delete" ON public.sourcing_events FOR DELETE TO authenticated USING (public.user_has_business_access(auth.uid(), business_id) AND status = 'draft');

CREATE TABLE public.sourcing_scoring_criteria (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sourcing_event_id uuid NOT NULL REFERENCES public.sourcing_events(id) ON DELETE CASCADE,
  code text NOT NULL, label text NOT NULL,
  weight numeric NOT NULL CHECK (weight >= 0 AND weight <= 100),
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sourcing_event_id, code)
);
CREATE INDEX idx_scoring_criteria_event ON public.sourcing_scoring_criteria(sourcing_event_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sourcing_scoring_criteria TO authenticated;
GRANT ALL ON public.sourcing_scoring_criteria TO service_role;
ALTER TABLE public.sourcing_scoring_criteria ENABLE ROW LEVEL SECURITY;
CREATE POLICY "scoring_criteria access" ON public.sourcing_scoring_criteria FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.sourcing_events e WHERE e.id = sourcing_event_id AND public.user_has_business_access(auth.uid(), e.business_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM public.sourcing_events e WHERE e.id = sourcing_event_id AND public.user_has_business_access(auth.uid(), e.business_id)));

CREATE TABLE public.sourcing_vendor_scores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sourcing_event_id uuid NOT NULL REFERENCES public.sourcing_events(id) ON DELETE CASCADE,
  criterion_id uuid NOT NULL REFERENCES public.sourcing_scoring_criteria(id) ON DELETE CASCADE,
  supplier_id uuid NOT NULL,
  score numeric NOT NULL CHECK (score >= 0 AND score <= 100),
  notes text, scored_by uuid NOT NULL,
  scored_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (criterion_id, supplier_id)
);
CREATE INDEX idx_vendor_scores_event ON public.sourcing_vendor_scores(sourcing_event_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sourcing_vendor_scores TO authenticated;
GRANT ALL ON public.sourcing_vendor_scores TO service_role;
ALTER TABLE public.sourcing_vendor_scores ENABLE ROW LEVEL SECURITY;
CREATE POLICY "vendor_scores access" ON public.sourcing_vendor_scores FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.sourcing_events e WHERE e.id = sourcing_event_id AND public.user_has_business_access(auth.uid(), e.business_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM public.sourcing_events e WHERE e.id = sourcing_event_id AND public.user_has_business_access(auth.uid(), e.business_id)));

CREATE TABLE public.sourcing_event_awards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sourcing_event_id uuid NOT NULL REFERENCES public.sourcing_events(id) ON DELETE CASCADE,
  supplier_id uuid NOT NULL,
  awarded_value numeric NOT NULL CHECK (awarded_value >= 0),
  currency text NOT NULL DEFAULT 'USD',
  composite_score numeric,
  contract_id uuid REFERENCES public.procurement_contracts(id) ON DELETE SET NULL,
  purchase_order_id uuid, award_reason text,
  awarded_by uuid NOT NULL,
  awarded_at timestamptz NOT NULL DEFAULT now(),
  is_sample_data boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sourcing_event_id, supplier_id)
);
CREATE INDEX idx_event_awards_event ON public.sourcing_event_awards(sourcing_event_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sourcing_event_awards TO authenticated;
GRANT ALL ON public.sourcing_event_awards TO service_role;
ALTER TABLE public.sourcing_event_awards ENABLE ROW LEVEL SECURITY;
CREATE POLICY "event_awards access" ON public.sourcing_event_awards FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.sourcing_events e WHERE e.id = sourcing_event_id AND public.user_has_business_access(auth.uid(), e.business_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM public.sourcing_events e WHERE e.id = sourcing_event_id AND public.user_has_business_access(auth.uid(), e.business_id)));

ALTER TABLE public.rfqs
  ADD COLUMN IF NOT EXISTS sourcing_event_id uuid REFERENCES public.sourcing_events(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_rfqs_sourcing_event ON public.rfqs(sourcing_event_id) WHERE sourcing_event_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.tg_sourcing_events_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
CREATE TRIGGER trg_sourcing_events_updated_at BEFORE UPDATE ON public.sourcing_events
  FOR EACH ROW EXECUTE FUNCTION public.tg_sourcing_events_updated_at();

CREATE OR REPLACE FUNCTION public.get_next_sourcing_event_number(_org_id uuid, _business_id uuid, _kind text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_prefix text; v_seq bigint;
BEGIN
  v_prefix := upper(_kind) || '-' || to_char(now(),'YYYY');
  SELECT COALESCE(MAX(NULLIF(regexp_replace(event_number, '^' || v_prefix || '-', ''), '')::bigint), 0) + 1
  INTO v_seq FROM public.sourcing_events
  WHERE business_id = _business_id AND event_number LIKE v_prefix || '-%';
  RETURN v_prefix || '-' || lpad(v_seq::text, 5, '0');
END $$;

CREATE OR REPLACE FUNCTION public._emit_sourcing_outbox(
  _org uuid, _biz uuid, _event_type text, _doc_id uuid, _idem text, _payload jsonb, _actor uuid
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.business_event_outbox(
    org_id, event_type, source_doc_type, source_doc_id, payload, idempotency_key, actor_user_id, source
  ) VALUES (
    _org, _event_type, 'sourcing_event', _doc_id,
    COALESCE(_payload,'{}'::jsonb) || jsonb_build_object('business_id', _biz),
    _idem, _actor, 'procurement'
  ) ON CONFLICT (idempotency_key) DO NOTHING;
END $$;

CREATE OR REPLACE FUNCTION public.create_sourcing_event(
  p_business_id uuid, p_kind text, p_title text, p_currency text DEFAULT 'USD',
  p_sealed_bid boolean DEFAULT false, p_opens_at timestamptz DEFAULT NULL,
  p_closes_at timestamptz DEFAULT NULL, p_target_ceiling_value numeric DEFAULT NULL,
  p_requisition_id uuid DEFAULT NULL, p_contract_id uuid DEFAULT NULL,
  p_notes text DEFAULT NULL, p_criteria jsonb DEFAULT '[]'::jsonb
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org_id uuid; v_uid uuid := auth.uid(); v_event_id uuid; v_event_number text;
  v_crit jsonb; v_weight_sum numeric := 0;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth required'; END IF;
  IF NOT public.user_has_business_access(v_uid, p_business_id) THEN
    RAISE EXCEPTION 'no access to business %', p_business_id;
  END IF;
  SELECT organization_id INTO v_org_id FROM public.businesses WHERE id = p_business_id;
  IF v_org_id IS NULL THEN RAISE EXCEPTION 'business not found'; END IF;
  v_event_number := public.get_next_sourcing_event_number(v_org_id, p_business_id, p_kind);
  INSERT INTO public.sourcing_events (
    organization_id, business_id, event_number, title, kind, currency,
    sealed_bid, opens_at, closes_at, target_ceiling_value, requisition_id, contract_id, notes, created_by
  ) VALUES (
    v_org_id, p_business_id, v_event_number, p_title, p_kind, p_currency,
    COALESCE(p_sealed_bid,false), p_opens_at, p_closes_at, p_target_ceiling_value,
    p_requisition_id, p_contract_id, p_notes, v_uid
  ) RETURNING id INTO v_event_id;
  IF p_criteria IS NOT NULL AND jsonb_array_length(p_criteria) > 0 THEN
    FOR v_crit IN SELECT * FROM jsonb_array_elements(p_criteria) LOOP
      INSERT INTO public.sourcing_scoring_criteria (sourcing_event_id, code, label, weight, sort_order)
      VALUES (v_event_id, v_crit->>'code', COALESCE(v_crit->>'label', v_crit->>'code'),
              COALESCE((v_crit->>'weight')::numeric,0), COALESCE((v_crit->>'sort_order')::int,0));
      v_weight_sum := v_weight_sum + COALESCE((v_crit->>'weight')::numeric, 0);
    END LOOP;
    IF round(v_weight_sum,2) <> 100 THEN
      RAISE EXCEPTION 'scoring criteria weights must sum to 100 (got %)', v_weight_sum;
    END IF;
  END IF;
  PERFORM public._emit_sourcing_outbox(v_org_id, p_business_id, 'procurement.sourcing.created', v_event_id,
    'procurement.sourcing.created:'||v_event_id::text||':draft',
    jsonb_build_object('event_id', v_event_id, 'kind', p_kind, 'created_by', v_uid), v_uid);
  RETURN v_event_id;
END $$;

CREATE OR REPLACE FUNCTION public.open_sourcing_event(p_event_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_ev record;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth required'; END IF;
  SELECT * INTO v_ev FROM public.sourcing_events WHERE id = p_event_id FOR UPDATE;
  IF v_ev IS NULL THEN RAISE EXCEPTION 'event not found'; END IF;
  IF NOT public.user_has_business_access(v_uid, v_ev.business_id) THEN RAISE EXCEPTION 'no access'; END IF;
  IF v_ev.status <> 'draft' THEN RAISE EXCEPTION 'only draft events can be opened (status=%)', v_ev.status; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.sourcing_scoring_criteria WHERE sourcing_event_id = p_event_id) THEN
    RAISE EXCEPTION 'cannot open event without scoring criteria';
  END IF;
  UPDATE public.sourcing_events
    SET status='open', opened_by=v_uid, opened_at=now(), opens_at=COALESCE(opens_at, now())
    WHERE id=p_event_id;
  PERFORM public._emit_sourcing_outbox(v_ev.organization_id, v_ev.business_id, 'procurement.sourcing.opened', p_event_id,
    'procurement.sourcing.opened:'||p_event_id::text||':open',
    jsonb_build_object('event_id', p_event_id, 'opened_by', v_uid), v_uid);
END $$;

CREATE OR REPLACE FUNCTION public.score_sourcing_vendor(
  p_event_id uuid, p_supplier_id uuid, p_scores jsonb
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_ev record; v_row jsonb; v_crit_id uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth required'; END IF;
  SELECT * INTO v_ev FROM public.sourcing_events WHERE id = p_event_id;
  IF v_ev IS NULL THEN RAISE EXCEPTION 'event not found'; END IF;
  IF NOT public.user_has_business_access(v_uid, v_ev.business_id) THEN RAISE EXCEPTION 'no access'; END IF;
  IF v_ev.status NOT IN ('open','evaluating') THEN RAISE EXCEPTION 'event not open for scoring (status=%)', v_ev.status; END IF;
  IF v_ev.status = 'open' THEN
    UPDATE public.sourcing_events SET status='evaluating' WHERE id = p_event_id;
  END IF;
  FOR v_row IN SELECT * FROM jsonb_array_elements(p_scores) LOOP
    SELECT id INTO v_crit_id FROM public.sourcing_scoring_criteria
      WHERE sourcing_event_id = p_event_id AND code = v_row->>'criterion_code';
    IF v_crit_id IS NULL THEN RAISE EXCEPTION 'unknown criterion code %', v_row->>'criterion_code'; END IF;
    INSERT INTO public.sourcing_vendor_scores (sourcing_event_id, criterion_id, supplier_id, score, notes, scored_by)
    VALUES (p_event_id, v_crit_id, p_supplier_id, (v_row->>'score')::numeric, v_row->>'notes', v_uid)
    ON CONFLICT (criterion_id, supplier_id) DO UPDATE
      SET score = EXCLUDED.score, notes = EXCLUDED.notes, scored_by = EXCLUDED.scored_by, scored_at = now();
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.close_sourcing_event(p_event_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_ev record;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth required'; END IF;
  SELECT * INTO v_ev FROM public.sourcing_events WHERE id = p_event_id FOR UPDATE;
  IF v_ev IS NULL THEN RAISE EXCEPTION 'event not found'; END IF;
  IF NOT public.user_has_business_access(v_uid, v_ev.business_id) THEN RAISE EXCEPTION 'no access'; END IF;
  IF v_ev.status NOT IN ('open','evaluating') THEN
    RAISE EXCEPTION 'only open/evaluating events can be closed (status=%)', v_ev.status;
  END IF;
  IF v_ev.created_by = v_uid THEN
    RAISE EXCEPTION 'SoD: sourcing event creator cannot close their own event';
  END IF;
  UPDATE public.sourcing_events
    SET status='closed', closed_by=v_uid, closed_at=now(), closes_at=COALESCE(closes_at, now())
    WHERE id=p_event_id;
  PERFORM public._emit_sourcing_outbox(v_ev.organization_id, v_ev.business_id, 'procurement.sourcing.closed', p_event_id,
    'procurement.sourcing.closed:'||p_event_id::text||':closed',
    jsonb_build_object('event_id', p_event_id, 'closed_by', v_uid), v_uid);
END $$;

CREATE OR REPLACE FUNCTION public.award_sourcing_event_atomic(
  p_event_id uuid, p_awards jsonb, p_justification text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid(); v_ev record; v_row jsonb; v_contract record;
  v_award_ids uuid[] := ARRAY[]::uuid[]; v_award_id uuid; v_total numeric := 0;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth required'; END IF;
  SELECT * INTO v_ev FROM public.sourcing_events WHERE id = p_event_id FOR UPDATE;
  IF v_ev IS NULL THEN RAISE EXCEPTION 'event not found'; END IF;
  IF NOT public.user_has_business_access(v_uid, v_ev.business_id) THEN RAISE EXCEPTION 'no access'; END IF;
  IF v_ev.status NOT IN ('closed','evaluating') THEN
    RAISE EXCEPTION 'only closed/evaluating events can be awarded (status=%)', v_ev.status;
  END IF;
  IF v_ev.created_by = v_uid THEN
    RAISE EXCEPTION 'SoD: sourcing event creator cannot award their own event';
  END IF;
  IF COALESCE(trim(p_justification),'') = '' THEN RAISE EXCEPTION 'award justification is required'; END IF;
  IF jsonb_array_length(p_awards) = 0 THEN RAISE EXCEPTION 'at least one award line is required'; END IF;
  FOR v_row IN SELECT * FROM jsonb_array_elements(p_awards) LOOP
    IF NULLIF(v_row->>'contract_id','') IS NOT NULL THEN
      SELECT * INTO v_contract FROM public.procurement_contracts WHERE id=(v_row->>'contract_id')::uuid FOR UPDATE;
      IF v_contract IS NULL THEN RAISE EXCEPTION 'contract not found: %', v_row->>'contract_id'; END IF;
      IF v_contract.business_id <> v_ev.business_id THEN RAISE EXCEPTION 'contract business mismatch'; END IF;
      IF v_contract.status <> 'active' THEN
        RAISE EXCEPTION 'cannot award against non-active contract (status=%)', v_contract.status;
      END IF;
      IF v_contract.ceiling_value IS NOT NULL AND
         (v_contract.utilized_value + (v_row->>'awarded_value')::numeric) > v_contract.ceiling_value THEN
        RAISE EXCEPTION 'award exceeds contract ceiling (contract=%, remaining=%, requested=%)',
          v_contract.contract_number,
          v_contract.ceiling_value - v_contract.utilized_value,
          (v_row->>'awarded_value')::numeric;
      END IF;
      UPDATE public.procurement_contracts
        SET utilized_value = utilized_value + (v_row->>'awarded_value')::numeric WHERE id = v_contract.id;
    END IF;
    INSERT INTO public.sourcing_event_awards (
      sourcing_event_id, supplier_id, awarded_value, currency, composite_score,
      contract_id, award_reason, awarded_by
    ) VALUES (
      p_event_id, (v_row->>'supplier_id')::uuid, (v_row->>'awarded_value')::numeric, v_ev.currency,
      NULLIF(v_row->>'composite_score','')::numeric, NULLIF(v_row->>'contract_id','')::uuid,
      v_row->>'award_reason', v_uid
    ) RETURNING id INTO v_award_id;
    v_award_ids := array_append(v_award_ids, v_award_id);
    v_total := v_total + (v_row->>'awarded_value')::numeric;
  END LOOP;
  UPDATE public.sourcing_events
    SET status='awarded', awarded_by=v_uid, awarded_at=now(), award_justification=p_justification
    WHERE id=p_event_id;
  PERFORM public._emit_sourcing_outbox(v_ev.organization_id, v_ev.business_id, 'procurement.sourcing.awarded', p_event_id,
    'procurement.sourcing.awarded:'||p_event_id::text||':awarded',
    jsonb_build_object('event_id', p_event_id, 'award_ids', to_jsonb(v_award_ids),
                       'total_awarded_value', v_total, 'awarded_by', v_uid), v_uid);
  RETURN jsonb_build_object('event_id', p_event_id, 'award_ids', to_jsonb(v_award_ids), 'total_awarded_value', v_total);
END $$;

INSERT INTO public.governance_duties (duty_code, label, description, domain)
VALUES ('sourcing.close', 'Close sourcing event', 'Closes bidding and freezes vendor scores for award', 'procurement')
ON CONFLICT (duty_code) DO NOTHING;

INSERT INTO public.governance_sod_conflicts (duty_a, duty_b, severity, rationale)
SELECT LEAST(a,b), GREATEST(a,b), 'high',
  'A user who closes a sourcing event must not also award it, to preserve four-eyes control over vendor selection.'
FROM (VALUES ('sourcing.award','sourcing.close')) AS t(a,b)
ON CONFLICT DO NOTHING;
