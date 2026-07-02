-- SoD: separate "Pay" capability for payroll/AP disbursement.
ALTER TABLE public.permission_group_rules
  ADD COLUMN IF NOT EXISTS can_pay boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.permission_group_rules.can_pay IS
  'Disburse cash for payroll payment batches and AP payments. Separates poster from payer (treasury SoD).';

-- Continuity: grant can_pay to any existing group rule that already grants Post-to-GL,
-- so admins who could mark batches paid today don't lose the capability mid-upgrade.
-- New tenants/groups start with can_pay = false and admins must explicitly grant it.
UPDATE public.permission_group_rules
   SET can_pay = true
 WHERE module = 'payroll'
   AND can_post = true
   AND can_pay = false;