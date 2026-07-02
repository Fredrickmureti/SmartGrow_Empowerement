-- C-PAY-4-FIX regression guard.
--
-- The payslip immutability trigger must remain country-agnostic. Statutory
-- amounts live in payslip_lines and are keyed by rule_code coming from the
-- active localization pack — they MUST NOT be enumerated by name in the
-- trigger body. A previous shipment of this trigger referenced Kenya
-- columns (paye/nhif/nssf_employee/housing_levy) that no longer exist on
-- public.payslips, silently breaking the payment-batch flow.
--
-- This test fails if:
--   (1) the trigger function disappears,
--   (2) the function body contains any country-specific token, or
--   (3) the trigger is not bound to public.payslips.

BEGIN;
SELECT plan(4);

-- (1) Trigger function exists.
SELECT has_function(
  'public', 'payslips_immutability_guard',
  'payslips_immutability_guard() must exist'
);

-- (2) Trigger is attached for UPDATE and DELETE on public.payslips.
SELECT has_trigger(
  'public', 'payslips', 'trg_payslips_immutable_upd',
  'BEFORE UPDATE immutability trigger must be attached to public.payslips'
);
SELECT has_trigger(
  'public', 'payslips', 'trg_payslips_immutable_del',
  'BEFORE DELETE immutability trigger must be attached to public.payslips'
);

-- (3) Function body contains NO country-specific statutory tokens.
SELECT ok(
  (
    SELECT NOT (pg_get_functiondef(p.oid) ~* '\m(paye|nhif|shif|nssf_employee|nssf_employer|housing_levy|ahl|nita|sdl|paye_uk|paye_ni|irpf|irpef)\M')
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'payslips_immutability_guard'
  ),
  'payslips_immutability_guard body must not reference country-specific statutory column names (paye/nhif/shif/nssf/housing_levy/ahl/nita/sdl/...)'
);

SELECT * FROM finish();
ROLLBACK;
