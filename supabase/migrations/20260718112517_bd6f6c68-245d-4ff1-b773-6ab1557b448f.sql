CREATE OR REPLACE FUNCTION public.guard_bill_self_approval()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
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
END $$;