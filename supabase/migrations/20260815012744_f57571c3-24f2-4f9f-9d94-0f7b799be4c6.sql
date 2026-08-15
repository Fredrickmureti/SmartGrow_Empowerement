-- Phase 6.3 — the AR spine becomes a governed document.
--
-- Until now `invoices` was the least protected Sales document: any client
-- could `update invoices set status = 'paid'`. The draft->posted rule lived in
-- a TypeScript `if`. Sales orders, estimates and proformas all reject the
-- equivalent write at the trigger; invoices now do too.
--
-- Mechanism mirrors `trg_00_sales_order_governed_write` exactly (PG_CONTEXT
-- stack ownership) so there is one pattern in the domain, not two.
--
-- Totals are deliberately NOT in the reject list: `_sales_header_totals_guard`
-- (Phase 4) already owns them and *rewrites* a disagreeing client value to the
-- line-derived one, which is stronger than rejecting the write.

CREATE OR REPLACE FUNCTION public.set_invoice_status_atomic(
  p_invoice_id uuid,
  p_status text,
  p_user_id uuid DEFAULT auth.uid()
)
RETURNS public.invoices
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inv public.invoices%ROWTYPE;
  v_target public.invoice_status;
  v_old text;
BEGIN
  SELECT * INTO v_inv FROM public.invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'set_invoice_status_atomic: invoice % not found', p_invoice_id
      USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.user_has_business_access(v_inv.business_id) THEN
    RAISE EXCEPTION 'set_invoice_status_atomic: not authorized for this business'
      USING ERRCODE = '42501';
  END IF;

  -- 'confirmed' is a legacy label; the canonical post-confirm status is 'sent'.
  v_target := (CASE WHEN p_status = 'confirmed' THEN 'sent' ELSE p_status END)::public.invoice_status;
  v_old := v_inv.status::text;

  IF v_target::text = v_old THEN
    RETURN v_inv;
  END IF;

  -- Legal transition table. Posting (draft -> anything post-confirm) is NOT
  -- here: it must go through confirm_invoice_atomic so the journal entry and
  -- the status move in one transaction.
  IF v_old = 'draft' AND v_target::text NOT IN ('cancelled') THEN
    RAISE EXCEPTION
      'Invoice % is a draft — confirm it (confirm_invoice_atomic) before moving it to %.',
      v_inv.invoice_number, v_target
      USING ERRCODE = '42501';
  END IF;

  IF v_old IN ('paid', 'voided', 'cancelled') THEN
    RAISE EXCEPTION
      'Invoice % is %; it may only be corrected by a credit note or reversal, not by a status change.',
      v_inv.invoice_number, v_old
      USING ERRCODE = '42501';
  END IF;

  -- Settlement statuses are derived from allocations by the payment engines.
  IF v_target::text IN ('partial', 'paid') THEN
    RAISE EXCEPTION
      'Invoice % — settlement status is derived from payments; record or unapply a payment instead.',
      v_inv.invoice_number
      USING ERRCODE = '42501';
  END IF;

  IF v_target::text IN ('voided') THEN
    RAISE EXCEPTION
      'Invoice % — use void_invoice_atomic to void an invoice.', v_inv.invoice_number
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.invoices
     SET status = v_target,
         updated_at = now()
   WHERE id = p_invoice_id
  RETURNING * INTO v_inv;

  RETURN v_inv;
END;
$$;

REVOKE ALL ON FUNCTION public.set_invoice_status_atomic(uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_invoice_status_atomic(uuid, text, uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.set_invoice_status_atomic(uuid, text, uuid) IS
  'Phase 6.3 — the only sanctioned path for a non-financial invoice status change (sent/viewed/overdue/cancelled). Posting, settlement and voiding remain owned by confirm_invoice_atomic, the payment engines and void_invoice_atomic.';

CREATE OR REPLACE FUNCTION public._invoices_governed_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_stack text;
  v_owned boolean;
  v_changed text[] := ARRAY[]::text[];
BEGIN
  IF public._is_teardown_for_org(COALESCE(NEW.organization_id, OLD.organization_id)) THEN
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    v_changed := array_append(v_changed, 'status');
  END IF;
  IF NEW.invoice_number IS DISTINCT FROM OLD.invoice_number THEN
    v_changed := array_append(v_changed, 'invoice_number');
  END IF;
  IF NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id THEN
    v_changed := array_append(v_changed, 'journal_entry_id');
  END IF;
  IF COALESCE(NEW.amount_paid, 0) IS DISTINCT FROM COALESCE(OLD.amount_paid, 0) THEN
    v_changed := array_append(v_changed, 'amount_paid');
  END IF;

  IF array_length(v_changed, 1) IS NULL THEN
    RETURN NEW;
  END IF;

  GET DIAGNOSTICS v_stack = PG_CONTEXT;

  v_owned :=
       v_stack ILIKE '%set_invoice_status_atomic%'
    OR v_stack ILIKE '%_confirm_invoice_core%'
    OR v_stack ILIKE '%confirm_invoice_atomic%'
    OR v_stack ILIKE '%confirm_invoice_and_release_stock_atomic%'
    OR v_stack ILIKE '%void_invoice_atomic%'
    OR v_stack ILIKE '%void_payment_atomic%'
    OR v_stack ILIKE '%record_multi_invoice_payment%'
    OR v_stack ILIKE '%record_advance_payment%'
    OR v_stack ILIKE '%reallocate_payment_atomic%'
    OR v_stack ILIKE '%unapply_payment_atomic%'
    OR v_stack ILIKE '%unreconcile_payment_atomic%'
    OR v_stack ILIKE '%apply_credit_to_invoice_atomic%'
    OR v_stack ILIKE '%apply_customer_deposit_atomic%'
    OR v_stack ILIKE '%issue_credit_note_atomic%'
    OR v_stack ILIKE '%issue_credit_note_for_payment_atomic%'
    OR v_stack ILIKE '%cascade_voided_invoice_allocations%'
    OR v_stack ILIKE '%create_credit_note_atomic%'
    OR v_stack ILIKE '%confirm_credit_note_atomic%'
    OR v_stack ILIKE '%create_sales_return_atomic%'
    OR v_stack ILIKE '%approve_sales_return_atomic%'
    OR v_stack ILIKE '%cancel_delivery_atomic%'
    OR v_stack ILIKE '%create_invoice_from_delivery_atomic%'
    OR v_stack ILIKE '%convert_so_to_invoice_atomic%'
    OR v_stack ILIKE '%convert_estimate_to_invoice_atomic%'
    OR v_stack ILIKE '%convert_proforma_to_invoice_atomic%'
    OR v_stack ILIKE '%create_pos_credit_sale_invoice_atomic%'
    OR v_stack ILIKE '%post_missing_invoice_journals%'
    OR v_stack ILIKE '%update_overdue_invoices%'
    OR v_stack ILIKE '%generate_3pl_invoice%'
    OR v_stack ILIKE '%generate_recurring_invoice%'
    OR v_stack ILIKE '%trg_invoice_lines_repost_revenue%'
    OR v_stack ILIKE '%_execute_organization_delete%';

  IF NOT v_owned THEN
    RAISE EXCEPTION
      'Invoice % — % may only be changed by the invoice engines (set_invoice_status_atomic, confirm_invoice_atomic, void_invoice_atomic, the payment/credit-note routes). Direct writes are rejected.',
      COALESCE(NEW.invoice_number, OLD.invoice_number), array_to_string(v_changed, ', ')
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_00_invoices_governed_write ON public.invoices;
CREATE TRIGGER trg_00_invoices_governed_write
  BEFORE UPDATE ON public.invoices
  FOR EACH ROW
  EXECUTE FUNCTION public._invoices_governed_write();