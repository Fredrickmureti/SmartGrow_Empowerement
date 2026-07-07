
-- Enterprise Fiscalization D4: source-table triggers → fiscal.receipt_required events
-- Country-agnostic: triggers no-op when the org has no fiscal provider pack installed
-- (the enqueue_fiscal_receipt_required helper already gates on installed pack).

-- Trigger fn: invoice becomes issued/approved → enqueue fiscal receipt
CREATE OR REPLACE FUNCTION public.tg_invoice_fiscal_enqueue()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status IN ('issued','sent','paid','approved','finalized')
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
    PERFORM public.enqueue_fiscal_receipt_required(
      NEW.organization_id, NULL, NEW.branch_id,
      'invoices', NEW.id, 'invoice',
      jsonb_build_object('total', NEW.total, 'invoice_number', NEW.invoice_number)
    );
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_invoice_fiscal_enqueue ON public.invoices;
CREATE TRIGGER trg_invoice_fiscal_enqueue
  AFTER INSERT OR UPDATE OF status ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.tg_invoice_fiscal_enqueue();

-- Invoice void → cancellation event
CREATE OR REPLACE FUNCTION public.tg_invoice_fiscal_cancel()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_provider text; v_event_id uuid;
BEGIN
  IF NEW.voided_at IS NOT NULL AND OLD.voided_at IS NULL THEN
    SELECT fp.provider_key INTO v_provider
    FROM public.installed_localization_packs ilp
    JOIN public.localization_pack_fiscal_providers fp ON fp.pack_id = ilp.pack_id
    WHERE ilp.organization_id = NEW.organization_id LIMIT 1;
    IF v_provider IS NOT NULL THEN
      INSERT INTO public.business_event_outbox (
        org_id, branch_id, event_type, source_doc_type, source_doc_id, payload
      ) VALUES (
        NEW.organization_id, NEW.branch_id, 'fiscal.receipt_cancelled',
        'invoices', NEW.id,
        jsonb_build_object('provider_key', v_provider, 'document_kind', 'cancellation')
      );
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_invoice_fiscal_cancel ON public.invoices;
CREATE TRIGGER trg_invoice_fiscal_cancel
  AFTER UPDATE OF voided_at ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.tg_invoice_fiscal_cancel();

-- Credit notes: on insert (issue) enqueue
CREATE OR REPLACE FUNCTION public.tg_credit_note_fiscal_enqueue()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status IN ('issued','sent','approved','finalized')
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
    PERFORM public.enqueue_fiscal_receipt_required(
      NEW.organization_id, NULL, NEW.branch_id,
      'credit_notes', NEW.id, 'credit_note',
      jsonb_build_object('total', NEW.total)
    );
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_credit_note_fiscal_enqueue ON public.credit_notes;
CREATE TRIGGER trg_credit_note_fiscal_enqueue
  AFTER INSERT OR UPDATE OF status ON public.credit_notes
  FOR EACH ROW EXECUTE FUNCTION public.tg_credit_note_fiscal_enqueue();

-- POS transactions: on finalize → enqueue
CREATE OR REPLACE FUNCTION public.tg_pos_transaction_fiscal_enqueue()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status IN ('completed','finalized','settled')
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
    PERFORM public.enqueue_fiscal_receipt_required(
      NEW.organization_id, NULL, NEW.branch_id,
      'pos_transactions', NEW.id,
      CASE WHEN NEW.total >= 0 THEN 'sale' ELSE 'return' END,
      jsonb_build_object('total', NEW.total)
    );
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_pos_transaction_fiscal_enqueue ON public.pos_transactions;
CREATE TRIGGER trg_pos_transaction_fiscal_enqueue
  AFTER INSERT OR UPDATE OF status ON public.pos_transactions
  FOR EACH ROW EXECUTE FUNCTION public.tg_pos_transaction_fiscal_enqueue();

-- Sales returns → treat as credit_note kind (KRA maps returns to receipt R)
CREATE OR REPLACE FUNCTION public.tg_sales_return_fiscal_enqueue()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status IN ('approved','completed','issued')
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
    PERFORM public.enqueue_fiscal_receipt_required(
      NEW.organization_id, NULL, NEW.branch_id,
      'sales_returns', NEW.id, 'return',
      jsonb_build_object('total', NEW.total)
    );
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_sales_return_fiscal_enqueue ON public.sales_returns;
CREATE TRIGGER trg_sales_return_fiscal_enqueue
  AFTER INSERT OR UPDATE OF status ON public.sales_returns
  FOR EACH ROW EXECUTE FUNCTION public.tg_sales_return_fiscal_enqueue();

-- Resend RPC used by the accountant workspace to requeue a stuck transmission.
CREATE OR REPLACE FUNCTION public.fiscal_transmission_resend(p_transmission_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row public.fiscal_transmissions%ROWTYPE; v_org uuid;
BEGIN
  SELECT * INTO v_row FROM public.fiscal_transmissions WHERE id = p_transmission_id;
  IF NOT FOUND THEN RETURN false; END IF;
  -- Only members of the org may resend
  SELECT organization_id INTO v_org FROM public.user_business_access
    WHERE user_id = auth.uid() AND organization_id = v_row.organization_id LIMIT 1;
  IF v_org IS NULL THEN RAISE EXCEPTION 'forbidden'; END IF;

  UPDATE public.fiscal_transmissions
    SET state='queued', next_attempt_at=NULL, last_error=NULL, attempt_count=0
    WHERE id = p_transmission_id;

  INSERT INTO public.business_event_outbox (
    org_id, branch_id, event_type, source_doc_type, source_doc_id, payload
  ) VALUES (
    v_row.organization_id, v_row.branch_id, 'fiscal.receipt_required',
    v_row.source_doc_type, v_row.source_doc_id,
    jsonb_build_object('provider_key', v_row.provider_key, 'document_kind', v_row.document_kind, 'resend', true)
  );
  RETURN true;
END $$;
GRANT EXECUTE ON FUNCTION public.fiscal_transmission_resend(uuid) TO authenticated;

COMMENT ON FUNCTION public.tg_invoice_fiscal_enqueue() IS
  'Emits fiscal.receipt_required on invoice issue/finalize. No-ops for orgs with no fiscal pack installed.';
