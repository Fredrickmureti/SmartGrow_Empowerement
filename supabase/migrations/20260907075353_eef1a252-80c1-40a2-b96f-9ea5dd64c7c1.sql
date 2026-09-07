-- 1. Drop ERP duties (point of sale, sales refunds) and everything referencing them.
DELETE FROM public.governance_sod_conflicts
 WHERE duty_a LIKE 'pos.%' OR duty_b LIKE 'pos.%'
    OR duty_a = 'refund.approve' OR duty_b = 'refund.approve';

DELETE FROM public.governance_duty_permission_map
 WHERE duty_code LIKE 'pos.%' OR duty_code = 'refund.approve';

DELETE FROM public.governance_duties
 WHERE duty_code LIKE 'pos.%' OR duty_code = 'refund.approve';

-- 2. Re-point surviving duties at granular microfinance permission modules.
UPDATE public.governance_duty_permission_map SET module = 'treasury'
 WHERE duty_code IN ('bank.modify','payment.execute');
UPDATE public.governance_duty_permission_map SET module = 'accounting'
 WHERE duty_code IN ('je.post','je.reverse','payment.create','payment.approve');
UPDATE public.governance_duty_permission_map SET module = 'applications'
 WHERE duty_code IN ('loan.request','loan.originate','loan.approve');
UPDATE public.governance_duty_permission_map SET module = 'loans'
 WHERE duty_code IN ('loan.disburse','loan.write_off');
UPDATE public.governance_duty_permission_map SET operation = 'reverse'
 WHERE duty_code = 'je.reverse';

-- 3. Cash-handling duty: receiving client money at the counter or meeting.
INSERT INTO public.governance_duties (duty_code, label, domain, description)
VALUES ('repayment.receive', 'Receive client repayment', 'lending',
        'Take in and receipt a client repayment at the counter or group meeting.')
ON CONFLICT (duty_code) DO UPDATE
  SET label = EXCLUDED.label, domain = EXCLUDED.domain, description = EXCLUDED.description;

INSERT INTO public.governance_duty_permission_map (duty_code, module, operation)
SELECT 'repayment.receive', 'repayments', 'create'
 WHERE NOT EXISTS (
   SELECT 1 FROM public.governance_duty_permission_map
    WHERE duty_code = 'repayment.receive' AND module = 'repayments' AND operation = 'create'
 );

INSERT INTO public.governance_sod_conflicts (duty_a, duty_b, severity, rationale)
VALUES
  ('loan.disburse','repayment.receive','critical',
   'Paying out a loan and receipting its repayments lets one officer cover a diverted disbursement.'),
  ('je.post','repayment.receive','high',
   'Receipting client cash and posting the ledger entry for it removes the second pair of eyes over branch collections.'),
  ('payment.execute','repayment.receive','high',
   'Receiving client cash and executing outgoing payments allows a shortfall to be papered over.')
ON CONFLICT DO NOTHING;