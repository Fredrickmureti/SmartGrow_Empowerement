-- 1. Detach retained tables from the purchasing chain
ALTER TABLE public.payments DROP COLUMN IF EXISTS bill_id;
ALTER TABLE public.bank_reconciliation_matches DROP COLUMN IF EXISTS matched_bill_payment_id;

-- 2. Patch live trigger functions that referenced supplier payments
CREATE OR REPLACE FUNCTION public.validate_bank_reconciliation_match_scope()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_txn record;
  v_je record;
  v_payment record;
  v_rule record;
  v_has_writeoff boolean;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status = 'reversed' AND NEW.status <> 'reversed' THEN
    RAISE EXCEPTION 'Reversed reconciliation matches cannot be re-confirmed or reopened in-place';
  END IF;

  SELECT organization_id, business_id, branch_id INTO v_txn
  FROM public.bank_transactions
  WHERE id = NEW.bank_transaction_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Bank reconciliation match references a missing bank transaction';
  END IF;

  IF NEW.organization_id IS DISTINCT FROM v_txn.organization_id
     OR NEW.business_id IS DISTINCT FROM v_txn.business_id THEN
    RAISE EXCEPTION 'Bank reconciliation match must use the same organization/company as the bank transaction';
  END IF;

  IF NEW.branch_id IS NOT NULL AND v_txn.branch_id IS NOT NULL AND NEW.branch_id IS DISTINCT FROM v_txn.branch_id THEN
    RAISE EXCEPTION 'Bank reconciliation match branch must match the bank transaction branch';
  END IF;

  IF NEW.matched_journal_entry_id IS NOT NULL THEN
    SELECT organization_id, business_id, branch_id INTO v_je
    FROM public.journal_entries
    WHERE id = NEW.matched_journal_entry_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Matched journal entry not found';
    END IF;
    IF v_je.organization_id IS DISTINCT FROM NEW.organization_id
       OR v_je.business_id IS DISTINCT FROM NEW.business_id THEN
      RAISE EXCEPTION 'Matched journal entry belongs to a different organization/company';
    END IF;
    IF NEW.branch_id IS NOT NULL AND v_je.branch_id IS NOT NULL AND NEW.branch_id IS DISTINCT FROM v_je.branch_id THEN
      RAISE EXCEPTION 'Matched journal entry belongs to a different branch';
    END IF;
  END IF;

  IF NEW.matched_payment_id IS NOT NULL THEN
    SELECT organization_id, business_id INTO v_payment
    FROM public.payments
    WHERE id = NEW.matched_payment_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Matched payment not found';
    END IF;
    IF v_payment.organization_id IS DISTINCT FROM NEW.organization_id
       OR v_payment.business_id IS DISTINCT FROM NEW.business_id THEN
      RAISE EXCEPTION 'Matched payment belongs to a different organization/company';
    END IF;
  END IF;

  IF NEW.rule_id IS NOT NULL THEN
    SELECT organization_id, business_id INTO v_rule
    FROM public.bank_reconciliation_rules
    WHERE id = NEW.rule_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Reconciliation rule not found';
    END IF;
    IF v_rule.organization_id IS DISTINCT FROM NEW.organization_id
       OR v_rule.business_id IS DISTINCT FROM NEW.business_id THEN
      RAISE EXCEPTION 'Reconciliation rule belongs to a different organization/company';
    END IF;
  END IF;

  IF NEW.status = 'confirmed' THEN
    SELECT EXISTS (
      SELECT 1 FROM public.bank_reconciliation_writeoffs w
      WHERE w.reconciliation_match_id = NEW.id
        AND w.status IN ('draft','posted')
    ) INTO v_has_writeoff;

    IF NEW.matched_journal_entry_id IS NULL
       AND NEW.matched_payment_id IS NULL
       AND NEW.matched_entity_id IS NULL
       AND NOT v_has_writeoff THEN
      RAISE EXCEPTION 'Confirmed reconciliation matches require a matched payment, journal entry, source entity, or write-off';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.validate_bank_transaction_accounting_scope()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_bank_account record;
  v_je record;
  v_payment record;
BEGIN
  SELECT organization_id, business_id INTO v_bank_account
  FROM public.bank_accounts
  WHERE id = NEW.bank_account_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Bank account not found for bank transaction';
  END IF;

  IF NEW.organization_id IS DISTINCT FROM v_bank_account.organization_id
     OR NEW.business_id IS DISTINCT FROM v_bank_account.business_id THEN
    RAISE EXCEPTION 'Bank transaction must belong to the same organization/company as its bank account';
  END IF;

  IF NEW.journal_entry_id IS NOT NULL THEN
    SELECT organization_id, business_id INTO v_je
    FROM public.journal_entries
    WHERE id = NEW.journal_entry_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Linked bank transaction journal entry not found';
    END IF;
    IF v_je.organization_id IS DISTINCT FROM NEW.organization_id
       OR v_je.business_id IS DISTINCT FROM NEW.business_id THEN
      RAISE EXCEPTION 'Bank transaction journal entry belongs to a different organization/company';
    END IF;
  END IF;

  IF NEW.reconciled_payment_id IS NOT NULL THEN
    SELECT organization_id, business_id INTO v_payment
    FROM public.payments
    WHERE id = NEW.reconciled_payment_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Linked reconciled payment not found';
    END IF;

    IF v_payment.organization_id IS DISTINCT FROM NEW.organization_id
       OR v_payment.business_id IS DISTINCT FROM NEW.business_id THEN
      RAISE EXCEPTION 'Reconciled payment belongs to a different organization/company';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

-- 3. Drop vendor/purchasing views
DROP VIEW IF EXISTS public.vendor_credit_tieout CASCADE;
DROP VIEW IF EXISTS public.vendor_ledger_entries CASCADE;
DROP VIEW IF EXISTS public.vendor_unapplied_advances CASCADE;

-- 4. Drop the purchasing / vendor-billing tables
DROP TABLE IF EXISTS public.bill_grn_matches CASCADE;
DROP TABLE IF EXISTS public.bill_match_exceptions CASCADE;
DROP TABLE IF EXISTS public.bill_match_results CASCADE;
DROP TABLE IF EXISTS public.bill_match_tolerance_policies CASCADE;
DROP TABLE IF EXISTS public.bill_payment_allocations CASCADE;
DROP TABLE IF EXISTS public.bill_payment_reversal_events CASCADE;
DROP TABLE IF EXISTS public.bill_payments CASCADE;
DROP TABLE IF EXISTS public.bill_items CASCADE;
DROP TABLE IF EXISTS public.vendor_credit_note_applications CASCADE;
DROP TABLE IF EXISTS public.vendor_credit_note_items CASCADE;
DROP TABLE IF EXISTS public.vendor_credit_movements CASCADE;
DROP TABLE IF EXISTS public.vendor_credit_balances CASCADE;
DROP TABLE IF EXISTS public.vendor_refunds CASCADE;
DROP TABLE IF EXISTS public.vendor_credit_notes CASCADE;
DROP TABLE IF EXISTS public.vendor_statement_send_jobs CASCADE;
DROP TABLE IF EXISTS public.vendor_statements CASCADE;
DROP TABLE IF EXISTS public.bills CASCADE;

-- 5. Drop purchasing / vendor-specific routines
DROP FUNCTION IF EXISTS public._emit_bill_match_outbox(uuid, text, jsonb) CASCADE;
DROP FUNCTION IF EXISTS public._resolve_vendor_credit_note_line(jsonb, uuid, uuid) CASCADE;
DROP FUNCTION IF EXISTS public._resolve_vendor_credit_note_lines(jsonb, uuid, uuid) CASCADE;
DROP FUNCTION IF EXISTS public._tg_stamp_bill_payment_currency() CASCADE;
DROP FUNCTION IF EXISTS public._tg_stamp_vcn_currency() CASCADE;
DROP FUNCTION IF EXISTS public._vcm_append_only() CASCADE;
DROP FUNCTION IF EXISTS public._vcm_project_balance() CASCADE;
DROP FUNCTION IF EXISTS public._vcn_requires_approval(uuid, uuid) CASCADE;
DROP FUNCTION IF EXISTS public._mirror_approval_to_vendor_credit_note() CASCADE;
DROP FUNCTION IF EXISTS public._landed_cost_guard_vendor_credit_note() CASCADE;
DROP FUNCTION IF EXISTS public.apply_vendor_advance_atomic(uuid, uuid, numeric, date, uuid, text) CASCADE;
DROP FUNCTION IF EXISTS public.apply_vendor_credit_atomic(uuid, uuid, numeric, uuid) CASCADE;
DROP FUNCTION IF EXISTS public.apply_vendor_credit_fifo_atomic(uuid, uuid, uuid, uuid[], uuid, uuid) CASCADE;
DROP FUNCTION IF EXISTS public.apply_vendor_credit_to_bill_atomic(uuid, uuid, uuid, uuid, numeric, uuid, text, uuid) CASCADE;
DROP FUNCTION IF EXISTS public.approve_bill(uuid) CASCADE;
DROP FUNCTION IF EXISTS public.approve_bill_atomic(uuid, uuid) CASCADE;
DROP FUNCTION IF EXISTS public.approve_bill_payment(uuid) CASCADE;
DROP FUNCTION IF EXISTS public.cascade_branch_from_bill() CASCADE;
DROP FUNCTION IF EXISTS public.check_bill_payment_allocation_consistency() CASCADE;
DROP FUNCTION IF EXISTS public.check_bill_payment_allocation_sum() CASCADE;
DROP FUNCTION IF EXISTS public.claim_vendor_statement_send_jobs(integer) CASCADE;
DROP FUNCTION IF EXISTS public.complete_vendor_statement_send_job(uuid, boolean, text) CASCADE;
DROP FUNCTION IF EXISTS public.confirm_bill_atomic(uuid, uuid) CASCADE;
DROP FUNCTION IF EXISTS public.create_bill_payment_journal_entry() CASCADE;
DROP FUNCTION IF EXISTS public.create_vendor_credit_note_atomic(uuid, uuid, uuid, uuid, uuid, date, text, jsonb, boolean, text, text, text, uuid, uuid, uuid, text, date, numeric, date) CASCADE;
DROP FUNCTION IF EXISTS public.delete_vendor_credit_note_atomic(uuid) CASCADE;
DROP FUNCTION IF EXISTS public.enforce_bill_payment_business_match() CASCADE;
DROP FUNCTION IF EXISTS public.enforce_unique_vendor_invoice_number() CASCADE;
DROP FUNCTION IF EXISTS public.enforce_vcn_application_business_match() CASCADE;
DROP FUNCTION IF EXISTS public.enforce_vcn_vendor_business_match() CASCADE;
DROP FUNCTION IF EXISTS public.enqueue_vendor_statement_send(uuid, text, text, text) CASCADE;
DROP FUNCTION IF EXISTS public.expense_convert_to_bill(uuid) CASCADE;
DROP FUNCTION IF EXISTS public.finance_ap_open_items_as_of(uuid, uuid, uuid, date) CASCADE;
DROP FUNCTION IF EXISTS public.finance_ap_vendor_credit_as_of(uuid, uuid, uuid, date) CASCADE;
DROP FUNCTION IF EXISTS public.finance_purchase_expense_reconciliation(uuid, date, date, uuid, uuid) CASCADE;
DROP FUNCTION IF EXISTS public.find_bill_vendor_business_mismatches() CASCADE;
DROP FUNCTION IF EXISTS public.get_ap_summary(uuid, uuid, uuid, date) CASCADE;
DROP FUNCTION IF EXISTS public.get_bill_status_counts(uuid, uuid, uuid) CASCADE;
DROP FUNCTION IF EXISTS public.get_bill_status_counts(uuid, uuid) CASCADE;
DROP FUNCTION IF EXISTS public.get_next_bill_number(uuid, uuid, uuid) CASCADE;
DROP FUNCTION IF EXISTS public.get_next_vendor_credit_note_number(uuid, uuid) CASCADE;
DROP FUNCTION IF EXISTS public.get_top_vendor_spend(uuid, uuid, date, date, uuid, integer) CASCADE;
DROP FUNCTION IF EXISTS public.guard_vendor_credit_note_self_approval() CASCADE;
DROP FUNCTION IF EXISTS public.issue_vendor_credit_note_atomic(uuid) CASCADE;
DROP FUNCTION IF EXISTS public.mark_po_billed(uuid, uuid) CASCADE;
DROP FUNCTION IF EXISTS public.match_bill_atomic(uuid, uuid, uuid) CASCADE;
DROP FUNCTION IF EXISTS public.po_resync_billed_state(uuid) CASCADE;
DROP FUNCTION IF EXISTS public.po_resync_billed_state_for_bill(uuid) CASCADE;
DROP FUNCTION IF EXISTS public.record_bill_payment_atomic(uuid, uuid, uuid, numeric, date, text, text, text, uuid, uuid, uuid, uuid, text) CASCADE;
DROP FUNCTION IF EXISTS public.record_bill_payment_atomic(uuid, uuid, uuid, numeric, date, text, text, text, uuid, uuid, uuid, uuid, text, numeric, uuid) CASCADE;
DROP FUNCTION IF EXISTS public.record_bill_payment_atomic(uuid, uuid, uuid, numeric, date, text, text, text, uuid, uuid, uuid, uuid, text, numeric, uuid, uuid) CASCADE;
DROP FUNCTION IF EXISTS public.record_multi_bill_payment(uuid, uuid, uuid, jsonb, numeric, date, text, text, text, uuid, uuid, uuid, uuid, text, numeric, uuid, uuid, numeric) CASCADE;
DROP FUNCTION IF EXISTS public.record_multi_bill_payment(uuid, uuid, uuid, jsonb, numeric, date, text, text, text, uuid, uuid, uuid, uuid, text, numeric, uuid) CASCADE;
DROP FUNCTION IF EXISTS public.record_vendor_advance_payment(uuid, uuid, uuid, numeric, date, text, text, text, uuid, uuid, uuid, uuid, uuid, text) CASCADE;
DROP FUNCTION IF EXISTS public.refund_from_vendor_atomic(uuid, uuid, numeric, date, text, text, text, text) CASCADE;
DROP FUNCTION IF EXISTS public.reject_bill_atomic(uuid, text, uuid) CASCADE;
DROP FUNCTION IF EXISTS public.resolve_bill_match_exception_atomic(uuid, text, text, uuid) CASCADE;
DROP FUNCTION IF EXISTS public.resolve_reversal_intent_vendor_credit_note(uuid) CASCADE;
DROP FUNCTION IF EXISTS public.resync_po_lines_on_bill_void() CASCADE;
DROP FUNCTION IF EXISTS public.reverse_vendor_credit_note_atomic(uuid, text, text, date, uuid, text) CASCADE;
DROP FUNCTION IF EXISTS public.submit_bill_atomic(uuid, uuid) CASCADE;
DROP FUNCTION IF EXISTS public.sync_po_line_billed_quantities() CASCADE;
DROP FUNCTION IF EXISTS public.trg_bill_lines_repost_cost() CASCADE;
DROP FUNCTION IF EXISTS public.trg_bill_to_cost() CASCADE;
DROP FUNCTION IF EXISTS public.unapply_vendor_credit_from_bill_atomic(uuid, text) CASCADE;
DROP FUNCTION IF EXISTS public.update_bill_items_atomic(uuid, jsonb) CASCADE;
DROP FUNCTION IF EXISTS public.update_vendor_credit_note_atomic(uuid, uuid, uuid, date, text, jsonb, text, text, text, date) CASCADE;
DROP FUNCTION IF EXISTS public.upsert_vendor_statement_atomic(jsonb) CASCADE;
DROP FUNCTION IF EXISTS public.vendor_advance_account(uuid) CASCADE;
DROP FUNCTION IF EXISTS public.vendor_credit_account(uuid) CASCADE;
DROP FUNCTION IF EXISTS public.vendor_credit_balance_id(uuid, uuid, uuid, text) CASCADE;
DROP FUNCTION IF EXISTS public.vendor_credit_note_approve(uuid) CASCADE;
DROP FUNCTION IF EXISTS public.vendor_credit_note_cancel(uuid, text) CASCADE;
DROP FUNCTION IF EXISTS public.vendor_credit_note_dispute(uuid, text) CASCADE;
DROP FUNCTION IF EXISTS public.vendor_credit_note_reject(uuid, text) CASCADE;
DROP FUNCTION IF EXISTS public.vendor_credit_note_resolve_dispute(uuid, text) CASCADE;
DROP FUNCTION IF EXISTS public.vendor_credit_note_submit(uuid) CASCADE;
DROP FUNCTION IF EXISTS public.void_bill_atomic(uuid, text, date, uuid, text, text) CASCADE;
DROP FUNCTION IF EXISTS public.void_bill_payment_atomic(uuid, text, date, uuid, text, text) CASCADE;
DROP FUNCTION IF EXISTS public.reset_module__purchases(uuid) CASCADE;
DROP FUNCTION IF EXISTS public.reset_module__vendor_returns(uuid) CASCADE;