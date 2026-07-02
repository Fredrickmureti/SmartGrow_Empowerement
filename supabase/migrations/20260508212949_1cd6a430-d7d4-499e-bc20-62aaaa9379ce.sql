-- Refine paid-path guard: allow service_role (edge functions / trusted server)
-- to flip status to 'paid'. Continues to block authenticated/anon clients.

CREATE OR REPLACE FUNCTION public.payroll_runs_paid_path_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.status = 'paid' AND COALESCE(OLD.status,'') <> 'paid' THEN
    -- service_role (edge functions) is the trusted posting path.
    -- The explicit GUC is also accepted for SECURITY DEFINER wrappers.
    IF auth.role() = 'service_role'
       OR COALESCE(current_setting('app.payroll_payment_via_batch', true), '') = 'on' THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION
      'Payroll runs can only be marked paid via the payment-batch posting path (post-payroll-payment-gl). Direct status updates are forbidden.'
      USING ERRCODE = '42501', HINT = 'payroll_paid_bypass_blocked';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.payslips_paid_path_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.status = 'paid' AND COALESCE(OLD.status,'') <> 'paid' THEN
    IF auth.role() = 'service_role'
       OR COALESCE(current_setting('app.payroll_payment_via_batch', true), '') = 'on' THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION
      'Payslips can only be marked paid via the payment-batch posting path (post-payroll-payment-gl). Direct status updates are forbidden.'
      USING ERRCODE = '42501', HINT = 'payroll_paid_bypass_blocked';
  END IF;
  RETURN NEW;
END;
$$;