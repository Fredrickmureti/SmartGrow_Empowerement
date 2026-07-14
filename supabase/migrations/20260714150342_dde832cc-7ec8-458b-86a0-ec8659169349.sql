CREATE OR REPLACE FUNCTION public.enqueue_fiscal_receipt_required(
  p_org_id uuid,
  p_business_id uuid,
  p_branch_id uuid,
  p_source_doc_type text,
  p_source_doc_id uuid,
  p_document_kind text,
  p_payload jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_provider_key text;
  v_event_id uuid;
BEGIN
  v_provider_key := public.resolve_fiscal_provider(p_org_id, p_branch_id);

  IF v_provider_key IS NULL THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.business_event_outbox (
    org_id,
    branch_id,
    event_type,
    source_doc_type,
    source_doc_id,
    payload,
    idempotency_key
  ) VALUES (
    p_org_id,
    p_branch_id,
    'fiscal.receipt_required',
    p_source_doc_type,
    p_source_doc_id,
    COALESCE(p_payload, '{}'::jsonb) || jsonb_build_object(
      'business_id', p_business_id,
      'document_kind', p_document_kind,
      'provider_key', v_provider_key
    ),
    'fiscal.receipt_required:' || p_source_doc_type || ':' || p_source_doc_id::text || ':' || COALESCE(p_document_kind, 'document')
  )
  ON CONFLICT (org_id, idempotency_key) DO UPDATE
    SET payload = EXCLUDED.payload,
        updated_at = now()
  RETURNING id INTO v_event_id;

  RETURN v_event_id;
END
$function$;

GRANT EXECUTE ON FUNCTION public.enqueue_fiscal_receipt_required(uuid,uuid,uuid,text,uuid,text,jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.tg_invoice_fiscal_enqueue()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status::text IN ('sent','paid','confirmed')
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
    PERFORM public.enqueue_fiscal_receipt_required(
      NEW.organization_id, NEW.business_id, NEW.branch_id,
      'invoices', NEW.id, 'invoice',
      jsonb_build_object('total', NEW.total, 'invoice_number', NEW.invoice_number)
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.tg_credit_note_fiscal_enqueue()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status::text IN ('issued','sent','approved','finalized')
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
    PERFORM public.enqueue_fiscal_receipt_required(
      NEW.organization_id, NEW.business_id, NEW.branch_id,
      'credit_notes', NEW.id, 'credit_note',
      jsonb_build_object('total', NEW.total)
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.tg_pos_transaction_fiscal_enqueue()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status::text IN ('completed','finalized','settled')
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
    PERFORM public.enqueue_fiscal_receipt_required(
      NEW.organization_id, NEW.business_id, NEW.branch_id,
      'pos_transactions', NEW.id,
      CASE WHEN NEW.total >= 0 THEN 'sale' ELSE 'return' END,
      jsonb_build_object('total', NEW.total)
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.tg_sales_return_fiscal_enqueue()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status::text IN ('approved','completed','issued')
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
    PERFORM public.enqueue_fiscal_receipt_required(
      NEW.organization_id, NEW.business_id, NEW.branch_id,
      'sales_returns', NEW.id, 'return',
      jsonb_build_object('total', NEW.total)
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.tg_invoice_fiscal_cancel()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_provider text;
  v_event_id uuid;
BEGIN
  IF NEW.voided_at IS NOT NULL AND OLD.voided_at IS NULL THEN
    v_provider := public.resolve_fiscal_provider(NEW.organization_id, NEW.branch_id);

    IF v_provider IS NOT NULL THEN
      INSERT INTO public.business_event_outbox (
        org_id, branch_id, event_type, source_doc_type, source_doc_id, payload, idempotency_key
      ) VALUES (
        NEW.organization_id, NEW.branch_id, 'fiscal.receipt_cancelled',
        'invoices', NEW.id,
        jsonb_build_object(
          'business_id', NEW.business_id,
          'provider_key', v_provider,
          'document_kind', 'cancellation'
        ),
        'fiscal.receipt_cancelled:invoices:' || NEW.id::text
      )
      ON CONFLICT (org_id, idempotency_key) DO UPDATE
        SET payload = EXCLUDED.payload,
            updated_at = now()
      RETURNING id INTO v_event_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.fiscal_transmission_resend(p_transmission_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.fiscal_transmissions%ROWTYPE;
  v_org uuid;
BEGIN
  SELECT * INTO v_row FROM public.fiscal_transmissions WHERE id = p_transmission_id;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  SELECT organization_id INTO v_org
    FROM public.user_business_access
   WHERE user_id = auth.uid()
     AND organization_id = v_row.organization_id
   LIMIT 1;

  IF v_org IS NULL THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  UPDATE public.fiscal_transmissions
     SET state = 'queued', next_attempt_at = NULL, last_error = NULL, attempt_count = 0
   WHERE id = p_transmission_id;

  INSERT INTO public.business_event_outbox (
    org_id, branch_id, event_type, source_doc_type, source_doc_id, payload, idempotency_key
  ) VALUES (
    v_row.organization_id, v_row.branch_id, 'fiscal.receipt_required',
    v_row.source_doc_type, v_row.source_doc_id,
    jsonb_build_object(
      'provider_key', v_row.provider_key,
      'document_kind', v_row.document_kind,
      'resend', true,
      'transmission_id', v_row.id
    ),
    'fiscal.receipt_required:transmission_resend:' || v_row.id::text
  )
  ON CONFLICT (org_id, idempotency_key) DO UPDATE
    SET payload = EXCLUDED.payload,
        status = 'pending'::public.business_event_status,
        updated_at = now();

  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.fiscal_transmission_resend(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';