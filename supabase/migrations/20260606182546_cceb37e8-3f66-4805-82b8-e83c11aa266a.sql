
-- C-PAY-5: retire the dead Kenya PAYE function and install a permanent
-- event-trigger guard so no future migration can recreate a country-named
-- function in the public schema.

DROP FUNCTION IF EXISTS public.calculate_kenya_paye(numeric, numeric, numeric);

CREATE OR REPLACE FUNCTION public._reject_country_named_function()
RETURNS event_trigger
LANGUAGE plpgsql
AS $$
DECLARE
  r record;
  v_name text;
BEGIN
  FOR r IN
    SELECT * FROM pg_event_trigger_ddl_commands()
    WHERE object_type IN ('function','procedure') AND schema_name = 'public'
  LOOP
    v_name := split_part(r.object_identity, '.', 2);
    v_name := split_part(v_name, '(', 1);
    IF v_name ~* '(_kenya|_uganda|_tanzania|_rwanda|_nigeria|_south_africa|_uk|_usa|paye|nhif|shif|nssf_employee|nssf_employer|housing_levy|^ahl_|_ahl$|^nita_|_nita$|kra_)' THEN
      RAISE EXCEPTION
        'Country/statutory-named function "%": fiscal rules must live in localization packs (payroll_statutory_rules), not in named SQL functions. Drive behaviour from rule.parameters / computation_method instead.',
        r.object_identity
        USING ERRCODE = '42501', HINT = 'country_agnostic_guard';
    END IF;
  END LOOP;
END;
$$;

DROP EVENT TRIGGER IF EXISTS trg_reject_country_named_function;
CREATE EVENT TRIGGER trg_reject_country_named_function
ON ddl_command_end
WHEN TAG IN ('CREATE FUNCTION','CREATE PROCEDURE','ALTER FUNCTION','ALTER PROCEDURE')
EXECUTE FUNCTION public._reject_country_named_function();
