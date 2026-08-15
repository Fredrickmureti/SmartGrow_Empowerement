-- Phase 6.3 (companion) — the opening-balance importer posts the journal
-- entry from the browser and then linked `invoices.journal_entry_id` with a
-- direct update, which the new governed-write trigger now rejects. Give that
-- one legitimate caller a narrow, server-checked door instead of widening the
-- guard: link-once, never re-point, business-scoped.

CREATE OR REPLACE FUNCTION public.link_invoice_journal_entry_atomic(
  p_invoice_id uuid,
  p_journal_entry_id uuid
)
RETURNS public.invoices
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inv public.invoices%ROWTYPE;
BEGIN
  SELECT * INTO v_inv FROM public.invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'link_invoice_journal_entry_atomic: invoice % not found', p_invoice_id
      USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.user_has_business_access(v_inv.business_id) THEN
    RAISE EXCEPTION 'link_invoice_journal_entry_atomic: not authorized for this business'
      USING ERRCODE = '42501';
  END IF;

  IF v_inv.journal_entry_id IS NOT NULL THEN
    IF v_inv.journal_entry_id = p_journal_entry_id THEN
      RETURN v_inv;
    END IF;
    RAISE EXCEPTION
      'Invoice % is already posted to a journal entry; re-pointing it would orphan the ledger.',
      v_inv.invoice_number
      USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.journal_entries je
     WHERE je.id = p_journal_entry_id
       AND je.business_id = v_inv.business_id
  ) THEN
    RAISE EXCEPTION
      'link_invoice_journal_entry_atomic: journal entry % does not belong to this business',
      p_journal_entry_id
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.invoices
     SET journal_entry_id = p_journal_entry_id,
         updated_at = now()
   WHERE id = p_invoice_id
  RETURNING * INTO v_inv;

  RETURN v_inv;
END;
$$;

REVOKE ALL ON FUNCTION public.link_invoice_journal_entry_atomic(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.link_invoice_journal_entry_atomic(uuid, uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.link_invoice_journal_entry_atomic(uuid, uuid) IS
  'Phase 6.3 — link-once door for the opening-balance importer. Not a general journal setter: confirm_invoice_atomic owns posting for ordinary invoices.';

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
    OR v_stack ILIKE '%link_invoice_journal_entry_atomic%'
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