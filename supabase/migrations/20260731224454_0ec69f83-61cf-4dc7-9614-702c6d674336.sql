-- Wave G3 — teardown-context bypass for the remaining append-only guards.
-- These triggers fire on DELETE and aborted reset_organization_data.

CREATE OR REPLACE FUNCTION public.loan_lifecycle_events_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $function$
BEGIN
  IF public._is_teardown_active() THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION 'loan_lifecycle_events is append-only';
END $function$;

CREATE OR REPLACE FUNCTION public.tg_loan_skip_override_events_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $function$
BEGIN
  IF public._is_teardown_active() THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION 'loan_skip_override_events is append-only';
END $function$;

CREATE OR REPLACE FUNCTION public.attendance_events_block_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $function$
BEGIN
  IF public._is_teardown_active() THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION 'attendance_events is append-only';
END $function$;

CREATE OR REPLACE FUNCTION public.payslip_events_forbid_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $function$
BEGIN
  IF public._is_teardown_active() THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION 'payslip_events is append-only (% is forbidden)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END $function$;

CREATE OR REPLACE FUNCTION public.tg_prevent_locked_timesheet_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $function$
BEGIN
  IF public._is_teardown_active() THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF COALESCE(OLD.payroll_locked, false) THEN
      RAISE EXCEPTION 'Timesheet is locked by a posted payroll run and cannot be deleted'
        USING ERRCODE = '55006';
    END IF;
    RETURN OLD;
  END IF;

  IF COALESCE(OLD.payroll_locked, false)
     AND COALESCE(NEW.payroll_locked, false) THEN
    IF NEW.hours       IS DISTINCT FROM OLD.hours
    OR NEW.date        IS DISTINCT FROM OLD.date
    OR NEW.project_id  IS DISTINCT FROM OLD.project_id
    OR NEW.task_id     IS DISTINCT FROM OLD.task_id
    OR NEW.start_time  IS DISTINCT FROM OLD.start_time
    OR NEW.end_time    IS DISTINCT FROM OLD.end_time
    OR NEW.is_billable IS DISTINCT FROM OLD.is_billable
    OR NEW.billing_rate IS DISTINCT FROM OLD.billing_rate THEN
      RAISE EXCEPTION 'Timesheet is locked by a posted payroll run and cannot be edited. An administrator must unlock the period first.'
        USING ERRCODE = '55006';
    END IF;
  END IF;
  RETURN NEW;
END $function$;