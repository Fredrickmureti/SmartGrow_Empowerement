
CREATE OR REPLACE FUNCTION public.guard_purchase_order_self_approval()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
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
$$;
