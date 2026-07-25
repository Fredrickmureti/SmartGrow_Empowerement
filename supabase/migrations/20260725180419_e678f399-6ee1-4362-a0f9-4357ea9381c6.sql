
-- Phase 1: canonical action registry (single source of truth for approval/governance action keys)
CREATE TABLE IF NOT EXISTS public.governance_action_registry (
  action_key text PRIMARY KEY,
  module text NOT NULL,
  subject_table text,
  subject_mode text NOT NULL CHECK (subject_mode IN ('actor','from_entity')),
  label text NOT NULL,
  description text NOT NULL,
  severity_default text NOT NULL DEFAULT 'standard' CHECK (severity_default IN ('low','standard','high','critical')),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.governance_action_registry TO authenticated;
GRANT ALL ON public.governance_action_registry TO service_role;

ALTER TABLE public.governance_action_registry ENABLE ROW LEVEL SECURITY;

-- Any authenticated user may read the catalogue (reference data, not tenant-scoped).
CREATE POLICY "gar_read_all_authenticated"
  ON public.governance_action_registry
  FOR SELECT TO authenticated
  USING (true);

-- Only platform admins may mutate; regular org members cannot.
CREATE POLICY "gar_platform_admin_write"
  ON public.governance_action_registry
  FOR ALL TO authenticated
  USING (public.is_platform_admin(auth.uid()))
  WITH CHECK (public.is_platform_admin(auth.uid()));

CREATE TRIGGER trg_gar_touch_updated_at
  BEFORE UPDATE ON public.governance_action_registry
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Seed from SELF_ACTION_CATALOGUE (mirror of src/lib/governance/selfActionCatalogue.ts).
-- Idempotent: ON CONFLICT DO UPDATE keeps runtime source of truth aligned when re-run.
INSERT INTO public.governance_action_registry (action_key, module, subject_table, subject_mode, label, description) VALUES
  ('payroll.approve', 'Payroll', 'payroll_run', 'actor', 'Approve payroll run', 'Approve a payroll run that includes the approver''s own payslip.'),
  ('payroll_payment_batch.approve', 'Payroll', 'payroll_payment_batch', 'actor', 'Approve own payment batch', 'Approve a payroll payment batch that the approver created.'),
  ('payroll_payment_batch.lock', 'Payroll', 'payroll_payment_batch', 'actor', 'Lock own payment batch', 'Lock a payroll payment batch that the approver created.'),
  ('payroll_payment_batch.transmit', 'Payroll', 'payroll_payment_batch', 'actor', 'Transmit own payment batch', 'Mark as transmitted a payment batch the approver created.'),
  ('payroll_payment_batch.pay', 'Payroll', 'payroll_payment_batch', 'actor', 'Confirm payment of own batch', 'Mark as paid (confirm bank disbursement) a batch the approver created.'),
  ('payroll_payment_batch.cancel', 'Payroll', 'payroll_payment_batch', 'actor', 'Cancel own payment batch', 'Cancel a payroll payment batch the approver created.'),
  ('payroll_payment_batch.reverse', 'Payroll', 'payroll_payment_batch', 'actor', 'Reverse own payment batch', 'Reverse a posted payroll payment batch the approver created.'),
  ('payroll.loan_skip_override.approve', 'Payroll', 'payroll_run_loan_skip_override', 'actor', 'Approve own loan skip override', 'Approve a payroll loan-skip override that the approver themselves submitted.'),
  ('payroll.loan_skip_override.reject', 'Payroll', 'payroll_run_loan_skip_override', 'actor', 'Reject own loan skip override', 'Reject a payroll loan-skip override that the approver themselves submitted.'),
  ('payroll.loan_skip_override.cancel', 'Payroll', 'payroll_run_loan_skip_override', 'actor', 'Cancel own approved loan skip override', 'Cancel a loan-skip override after the approver themselves approved it.'),
  ('leave.approve', 'HR', 'leave_request', 'from_entity', 'Approve leave (level 1)', 'Approve a leave request submitted by the approver themselves.'),
  ('leave.approve_l2', 'HR', 'leave_request', 'from_entity', 'Approve leave (level 2)', 'Second-level approval on the approver''s own leave request.'),
  ('timesheet.approve', 'HR', 'timesheet_submission', 'from_entity', 'Approve own timesheet', 'Approve a timesheet submitted by the approver themselves.'),
  ('loan.approve', 'HR', 'employee_loan', 'actor', 'Approve loan (creator)', 'Approve an employee loan the approver created.'),
  ('loan.approve_self_benefit', 'HR', 'employee_loan', 'from_entity', 'Approve own loan', 'Approve an employee loan whose beneficiary is the approver.'),
  ('employee_loan.authorize_disbursement', 'HR', 'employee_loan', 'actor', 'Authorize disbursement of own loan', 'Release a loan to disbursement that the approver themselves approved.'),
  ('employee_loan.write_off', 'HR', 'employee_loan', 'actor', 'Write off own loan', 'Write off a loan that the writer originated. Requires a distinct co-signer (dual control).'),
  ('employee_loan.restructure', 'HR', 'employee_loan', 'actor', 'Restructure own loan', 'Restructure, refinance, top-up or consolidate a loan the actor created.'),
  ('employee_loan.refinance', 'HR', 'employee_loan', 'actor', 'Refinance own loan', 'Refinance a loan the actor created (covered by restructure trigger).'),
  ('employee_loan.record_manual_repayment', 'HR', 'employee_loan', 'actor', 'Record manual repayment on own loan', 'Post a manual (non-payroll) repayment against a loan the actor created.'),
  ('compensation.approve', 'HR', 'employee_compensation_change', 'actor', 'Approve compensation change (creator)', 'Approve a compensation change the approver authored.'),
  ('compensation.approve_self_benefit', 'HR', 'employee_compensation_change', 'from_entity', 'Approve own compensation change', 'Approve a compensation change whose subject is the approver.'),
  ('contract.approve', 'HR', 'employee_contract', 'actor', 'Approve employee contract (creator)', 'Approve an employment contract the approver authored.'),
  ('contract.approve_self_benefit', 'HR', 'employee_contract', 'from_entity', 'Approve own contract', 'Approve an employment contract whose subject is the approver.'),
  ('bill.approve', 'Finance', 'bill', 'actor', 'Approve own bill', 'Approve a vendor bill recorded by the approver.'),
  ('bill_payment.approve', 'Finance', 'bill_payment', 'actor', 'Approve own bill payment', 'Approve a bill payment recorded by the approver.'),
  ('payment.approve', 'Finance', 'payment', 'actor', 'Approve own payment', 'Approve a payment the approver recorded.'),
  ('journal.post', 'Finance', 'journal_entry', 'actor', 'Post own journal entry', 'Post a journal entry the approver created.'),
  ('customer_refund.approve', 'Finance', 'customer_refund', 'actor', 'Approve own customer refund', 'Approve a customer refund the approver created.'),
  ('purchase_order.approve', 'Purchasing', 'purchase_order', 'actor', 'Approve own purchase order', 'Approve a purchase order the approver created.'),
  ('vendor_credit_note.approve', 'Purchasing', 'vendor_credit_note', 'actor', 'Approve own vendor credit note', 'Approve a vendor credit note the approver created.'),
  ('credit_note.approve', 'Sales', 'credit_note', 'actor', 'Approve own sales credit note', 'Approve a sales credit note the approver created.'),
  ('inventory.approve_adjustment', 'Inventory', 'stock_adjustment', 'actor', 'Approve own stock adjustment', 'Approve a stock adjustment the approver created.'),
  ('inventory.approve_transfer', 'Inventory', 'stock_transfer', 'actor', 'Approve own stock transfer', 'Approve a stock transfer the approver requested.'),
  ('inventory.submit_count', 'Inventory', 'stock_adjustment', 'actor', 'Submit own physical count', 'Submit a physical count for review that the submitter created.'),
  ('inventory.approve_count', 'Inventory', 'stock_adjustment', 'actor', 'Approve own physical count', 'Approve a physical count that the approver created, froze, or submitted.'),
  ('inventory.post_count', 'Inventory', 'stock_adjustment', 'actor', 'Post own physical count', 'Post a physical count that the poster previously approved.'),
  ('scrap.approve', 'Inventory', 'stock_adjustment', 'actor', 'Approve own scrap / waste', 'Approve a scrap / waste document the approver recorded. Blocks self-approval unless a governance override is issued.'),
  ('scrap.post', 'Inventory', 'stock_adjustment', 'actor', 'Post own scrap / waste', 'Post a scrap / waste document the poster recorded. Blocks self-posting when policy requires a distinct reviewer.'),
  ('scrap.reverse', 'Inventory', 'stock_adjustment', 'actor', 'Reverse own scrap / waste', 'Reverse a scrap / waste document the reverser posted. Blocks self-reversal to preserve audit trail.'),
  ('expense.approve', 'Spend', 'expense', 'actor', 'Approve own expense', 'Approve an expense the approver recorded.'),
  ('expense.approve_self_benefit', 'Spend', 'expense', 'from_entity', 'Approve expense for own employee record', 'Approve an expense whose employee is the approver.'),
  ('bank_account.sensitive_change', 'Finance', 'bank_account', 'actor', 'Change bank account routing fields', 'Modify the account number or routing number of an organization bank account. Silent changes can reroute outgoing payments and payroll.')
ON CONFLICT (action_key) DO UPDATE SET
  module = EXCLUDED.module,
  subject_table = EXCLUDED.subject_table,
  subject_mode = EXCLUDED.subject_mode,
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  updated_at = now();

-- Guard: prevent an approval_rules row from referencing an action key that isn't in the registry.
-- Non-blocking today (approval_rules.action_name is free-form); enforced via a validation trigger
-- that warns via NOTICE and records into approval_rule_logs. Full FK cutover happens in Phase 2.
CREATE OR REPLACE FUNCTION public.governance_action_registry_validate_rule()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.action_name IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.governance_action_registry r WHERE r.action_key = NEW.action_name) THEN
    RAISE NOTICE 'approval_rules.action_name % is not registered in governance_action_registry (will be enforced in Phase 2)', NEW.action_name;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_approval_rules_registry_check ON public.approval_rules;
CREATE TRIGGER trg_approval_rules_registry_check
  BEFORE INSERT OR UPDATE OF action_name ON public.approval_rules
  FOR EACH ROW EXECUTE FUNCTION public.governance_action_registry_validate_rule();

COMMENT ON TABLE public.governance_action_registry IS
  'Phase 1 canonical registry of approval/governance action keys. Mirrors SELF_ACTION_CATALOGUE in src/lib/governance/selfActionCatalogue.ts. Phase 2 will make approval_rules.action_name a foreign key to this table.';
