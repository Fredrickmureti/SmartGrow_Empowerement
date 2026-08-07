CREATE OR REPLACE FUNCTION public.guard_credit_note_self_approval()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $function$
BEGIN
  IF public._sod_is_approved_status(NEW.status::text)
     AND NOT public._sod_is_approved_status(COALESCE(OLD.status::text,'')) THEN
    IF NEW.approved_by IS NOT NULL THEN
      PERFORM public.governance_assert_not_self(
        NEW.approved_by, NEW.created_by, 'credit_note.approve',
        NEW.organization_id, 'credit_note', NEW.id
      );
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.guard_bill_self_approval()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $function$
BEGIN
  IF public._sod_is_approved_status(NEW.status::text)
     AND NOT public._sod_is_approved_status(COALESCE(OLD.status::text,'')) THEN
    IF NEW.approved_by IS NOT NULL THEN
      PERFORM public.governance_assert_not_self(
        NEW.approved_by, NEW.created_by, 'bill.approve',
        NEW.organization_id, 'bill', NEW.id
      );
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.guard_purchase_order_self_approval()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $function$
BEGIN
  IF public._sod_is_approved_status(NEW.status::text)
     AND NOT public._sod_is_approved_status(COALESCE(OLD.status::text,'')) THEN
    IF NEW.approved_by IS NOT NULL THEN
      PERFORM public.governance_assert_not_self(
        NEW.approved_by, NEW.created_by, 'purchase_order.approve',
        NEW.organization_id, 'purchase_order', NEW.id
      );
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.guard_expense_self_approval()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $function$
BEGIN
  IF public._sod_is_approved_status(NEW.status::text)
     AND NOT public._sod_is_approved_status(COALESCE(OLD.status::text,'')) THEN
    IF NEW.approved_by IS NOT NULL THEN
      PERFORM public.governance_assert_not_self(
        NEW.approved_by, NEW.created_by, 'expense.approve',
        NEW.organization_id, 'expense', NEW.id
      );
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

DO $$
DECLARE v_res jsonb;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub','af903a2e-3ab0-43f5-b2f0-1a4000985084','role','authenticated')::text, true);
  SELECT public.issue_credit_note_atomic('12a06274-0542-4cde-a754-3577db2d498d'::uuid) INTO v_res;
  RAISE NOTICE 'issue result: %', v_res;
END $$;

NOTIFY pgrst, 'reload schema';