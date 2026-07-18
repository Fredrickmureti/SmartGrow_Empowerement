
DO $smoke$
DECLARE
  v_org      uuid := '8e682296-c634-44c8-ae00-bc48940ec28b';
  v_biz      uuid := 'bf392ca6-a743-435c-ae41-5bf25199470d';
  v_user_a   uuid := 'af903a2e-3ab0-43f5-b2f0-1a4000985084';
  v_user_b   uuid := '351895bd-78d1-49e9-8757-5ca681562940';
  v_run_tag  text := 'smoke-d-' || substr(md5(random()::text), 1, 8);
  v_contact  uuid;
  v_supplier uuid;
  v_contract uuid;
  v_event    uuid;
  v_award    jsonb;
  v_util     numeric;
  v_outbox   int;
  v_caught   boolean;
BEGIN
  BEGIN
    PERFORM set_config('request.jwt.claim.sub', v_user_a::text, true);

    INSERT INTO public.contacts (organization_id, business_id, name, type, supplier_rank)
    VALUES (v_org, v_biz, v_run_tag || ' Sourcing Supplier', 'supplier', 1)
    RETURNING id INTO v_contact;

    INSERT INTO public.suppliers (organization_id, business_id, contact_id, supplier_code, lifecycle_state, created_by)
    VALUES (v_org, v_biz, v_contact, v_run_tag || '-supp', 'approved', v_user_a)
    RETURNING id INTO v_supplier;

    INSERT INTO public.procurement_contracts (
      organization_id, business_id, supplier_id, contract_number, title,
      kind, status, currency, start_date, end_date, ceiling_value,
      utilized_value, created_by, approved_by, approved_at
    ) VALUES (
      v_org, v_biz, v_supplier, 'CT-' || v_run_tag, 'Smoke D Contract',
      'blanket', 'active', 'USD', current_date, current_date + interval '1 year', 100000,
      0, v_user_a, v_user_b, now()
    ) RETURNING id INTO v_contract;

    -- Pre-seed opens_at to 1 minute in the past so the transaction-frozen
    -- now() used by close still satisfies closes_at > opens_at.
    v_event := public.create_sourcing_event(
      v_biz, 'rfq', 'Smoke D RFQ', 'USD', false,
      (now() - interval '1 minute')::timestamptz,
      NULL, NULL, NULL, v_contract, 'smoke',
      jsonb_build_array(
        jsonb_build_object('code','price',  'label','Price',  'weight', 60, 'sort_order', 1),
        jsonb_build_object('code','quality','label','Quality','weight', 40, 'sort_order', 2)
      )
    );
    IF v_event IS NULL THEN RAISE EXCEPTION 'SMOKE FAIL: create_sourcing_event returned null'; END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.business_event_outbox
      WHERE event_type='procurement.sourcing.created' AND source_doc_id=v_event
    ) THEN RAISE EXCEPTION 'SMOKE FAIL: missing procurement.sourcing.created outbox row'; END IF;
    IF (SELECT count(*) FROM public.sourcing_scoring_criteria WHERE sourcing_event_id=v_event) <> 2
    THEN RAISE EXCEPTION 'SMOKE FAIL: expected 2 scoring criteria rows'; END IF;

    PERFORM public.open_sourcing_event(v_event);
    IF (SELECT status FROM public.sourcing_events WHERE id=v_event) <> 'open'
    THEN RAISE EXCEPTION 'SMOKE FAIL: event not open'; END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.business_event_outbox
      WHERE event_type='procurement.sourcing.opened' AND source_doc_id=v_event
    ) THEN RAISE EXCEPTION 'SMOKE FAIL: missing procurement.sourcing.opened outbox row'; END IF;

    PERFORM public.score_sourcing_vendor(
      v_event, v_supplier,
      jsonb_build_array(
        jsonb_build_object('criterion_code','price',  'score', 88),
        jsonb_build_object('criterion_code','quality','score', 92)
      )
    );
    IF (SELECT count(*) FROM public.sourcing_vendor_scores WHERE sourcing_event_id=v_event) <> 2
    THEN RAISE EXCEPTION 'SMOKE FAIL: expected 2 vendor score rows'; END IF;

    -- Self-close SoD block
    v_caught := false;
    BEGIN
      PERFORM public.close_sourcing_event(v_event);
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM NOT ILIKE '%creator cannot close%' THEN RAISE; END IF;
      v_caught := true;
    END;
    IF NOT v_caught THEN RAISE EXCEPTION 'SMOKE FAIL: self-close SoD not enforced'; END IF;

    -- Close by user_b succeeds
    PERFORM set_config('request.jwt.claim.sub', v_user_b::text, true);
    PERFORM public.close_sourcing_event(v_event);
    IF (SELECT status FROM public.sourcing_events WHERE id=v_event) <> 'closed'
    THEN RAISE EXCEPTION 'SMOKE FAIL: event not closed after user_b close'; END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.business_event_outbox
      WHERE event_type='procurement.sourcing.closed' AND source_doc_id=v_event
    ) THEN RAISE EXCEPTION 'SMOKE FAIL: missing procurement.sourcing.closed outbox row'; END IF;

    -- Over-ceiling award rejected
    v_caught := false;
    BEGIN
      PERFORM public.award_sourcing_event_atomic(
        v_event,
        jsonb_build_array(jsonb_build_object(
          'supplier_id', v_supplier,
          'awarded_value', 150000,
          'contract_id', v_contract,
          'award_reason', 'over-ceiling attempt'
        )),
        'smoke over-ceiling'
      );
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM NOT ILIKE '%exceeds contract ceiling%' THEN RAISE; END IF;
      v_caught := true;
    END;
    IF NOT v_caught THEN RAISE EXCEPTION 'SMOKE FAIL: contract ceiling breach not enforced'; END IF;

    SELECT utilized_value INTO v_util FROM public.procurement_contracts WHERE id=v_contract;
    IF v_util <> 0 THEN
      RAISE EXCEPTION 'SMOKE FAIL: contract utilized_value moved on failed award (got %)', v_util;
    END IF;

    -- Valid award
    v_award := public.award_sourcing_event_atomic(
      v_event,
      jsonb_build_array(jsonb_build_object(
        'supplier_id', v_supplier,
        'awarded_value', 50000,
        'contract_id', v_contract,
        'composite_score', 89.6,
        'award_reason', 'smoke valid award'
      )),
      'smoke award justification'
    );
    IF (v_award->>'total_awarded_value')::numeric <> 50000
    THEN RAISE EXCEPTION 'SMOKE FAIL: awarded total wrong: %', v_award; END IF;
    IF (SELECT status FROM public.sourcing_events WHERE id=v_event) <> 'awarded'
    THEN RAISE EXCEPTION 'SMOKE FAIL: event not marked awarded'; END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.business_event_outbox
      WHERE event_type='procurement.sourcing.awarded' AND source_doc_id=v_event
    ) THEN RAISE EXCEPTION 'SMOKE FAIL: missing procurement.sourcing.awarded outbox row'; END IF;

    SELECT utilized_value INTO v_util FROM public.procurement_contracts WHERE id=v_contract;
    IF v_util <> 50000 THEN
      RAISE EXCEPTION 'SMOKE FAIL: contract utilized_value expected 50000, got %', v_util;
    END IF;

    SELECT count(*) INTO v_outbox
    FROM public.business_event_outbox
    WHERE source_doc_id = v_event
      AND event_type IN (
        'procurement.sourcing.created',
        'procurement.sourcing.opened',
        'procurement.sourcing.closed',
        'procurement.sourcing.awarded'
      );
    IF v_outbox < 4 THEN
      RAISE EXCEPTION 'SMOKE FAIL: expected >=4 sourcing outbox rows, got %', v_outbox;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public.business_event_outbox
      WHERE source_doc_id = v_event
        AND event_type = 'procurement.sourcing.awarded'
        AND idempotency_key = 'procurement.sourcing.awarded:'||v_event::text||':awarded'
    ) THEN
      RAISE EXCEPTION 'SMOKE FAIL: awarded outbox idempotency_key does not match <event>:<entity>:<state> shape';
    END IF;

    RAISE NOTICE 'Procurement Batch D-Verify: sourcing lifecycle passed, % outbox events, contract utilized_value=%',
      v_outbox, v_util;
    RAISE EXCEPTION '__SMOKE_ROLLBACK_MARKER__';

  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM <> '__SMOKE_ROLLBACK_MARKER__' THEN RAISE; END IF;
      RAISE NOTICE 'Procurement Batch D-Verify PASSED (smoke rolled back cleanly)';
  END;
END
$smoke$;
