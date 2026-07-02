-- Drop the existing check constraint and add a new one that includes "converted"
ALTER TABLE public.audit_logs DROP CONSTRAINT IF EXISTS audit_logs_action_check;

ALTER TABLE public.audit_logs ADD CONSTRAINT audit_logs_action_check 
  CHECK (action IN ('created', 'updated', 'deleted', 'sent', 'viewed', 'paid', 'partial_paid', 'converted', 'approved', 'rejected', 'cancelled', 'voided'));