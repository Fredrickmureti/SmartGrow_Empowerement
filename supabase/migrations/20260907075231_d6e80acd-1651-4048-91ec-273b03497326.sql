-- Orphaned ERP routers: both reference tables that no longer exist
-- (physical_counts, rfqs) and are the only remaining SQL callers of the
-- ERP action keys pruned below.
DROP FUNCTION IF EXISTS public.physical_count_submit(uuid, uuid, boolean);
DROP FUNCTION IF EXISTS public.rfq_submit_for_approval(uuid);

-- Normalise module labels on the rows we keep.
UPDATE public.governance_action_registry SET module = 'Spend'
 WHERE action_key IN ('expense.submit','expense.void','reversal.expense');

-- Lending actions this institution needs.
INSERT INTO public.governance_action_registry
  (action_key, module, subject_table, subject_mode, label, description,
   severity_default, is_active, requires_approval_always)
VALUES
  ('loan.approve','Lending','mf_loan_applications','actor',
   'Approve own loan application','Approve a client loan application the approver captured or assessed.',
   'critical', true, false),
  ('loan.disburse','Lending','mf_loans','actor',
   'Disburse own approved loan','Release funds on a loan the approver approved.',
   'critical', true, false),
  ('loan.write_off','Lending','mf_loans','actor',
   'Write off own loan','Write off a loan the approver originated or manages.',
   'critical', true, false),
  ('loan.restructure','Lending','mf_loans','actor',
   'Restructure own loan','Reschedule or refinance a loan the approver originated.',
   'high', true, false),
  ('repayment.reverse','Lending','mf_repayments','actor',
   'Reverse own repayment','Reverse a client repayment the approver recorded.',
   'critical', true, false),
  ('reversal.loan_repayment','Lending','mf_repayments','from_entity',
   'Reverse a registered loan repayment','Reversal routed through the reversal register for loan repayments.',
   'high', true, false)
ON CONFLICT (action_key) DO UPDATE
  SET module = EXCLUDED.module,
      subject_table = EXCLUDED.subject_table,
      subject_mode = EXCLUDED.subject_mode,
      label = EXCLUDED.label,
      description = EXCLUDED.description,
      severity_default = EXCLUDED.severity_default,
      is_active = true;

-- Prune every remaining ERP action key. Safe: approval_requests,
-- approval_history, approval_rules and self_action_policy are all empty,
-- and no surviving SQL function or app module routes these keys.
-- Rollback: re-seed from the pre-migration snapshot of
-- governance_action_registry (see plan archive for the full row list).
DELETE FROM public.governance_action_registry
 WHERE action_key NOT IN (
   'payment.approve','journal.post','bank_account.sensitive_change',
   'expense.approve','expense.approve_self_benefit','expense.submit',
   'expense.void','reversal.expense','app_access.grant',
   'loan.approve','loan.disburse','loan.write_off','loan.restructure',
   'repayment.reverse','reversal.loan_repayment'
 );

SELECT public.assert_approval_action_keys_registered();