
CREATE OR REPLACE FUNCTION public.apply_garnishment_payment_to_order()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_garn_id uuid;
  v_org uuid;
  v_delta numeric;
  v_actor uuid;
  v_order record;
BEGIN
  v_actor := auth.uid();

  IF TG_OP = 'INSERT' THEN
    SELECT garnishment_id, organization_id INTO v_garn_id, v_org
    FROM public.payroll_liabilities WHERE id = NEW.liability_id;
    v_delta := COALESCE(NEW.amount, 0);
  ELSIF TG_OP = 'DELETE' THEN
    SELECT garnishment_id, organization_id INTO v_garn_id, v_org
    FROM public.payroll_liabilities WHERE id = OLD.liability_id;
    v_delta := -COALESCE(OLD.amount, 0);
  ELSE
    SELECT garnishment_id, organization_id INTO v_garn_id, v_org
    FROM public.payroll_liabilities WHERE id = NEW.liability_id;
    v_delta := COALESCE(NEW.amount, 0) - COALESCE(OLD.amount, 0);
  END IF;

  IF v_garn_id IS NULL OR v_delta = 0 THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  UPDATE public.employee_garnishments
     SET total_paid = GREATEST(0, COALESCE(total_paid, 0) + v_delta),
         updated_at = now()
   WHERE id = v_garn_id
  RETURNING * INTO v_order;

  IF v_order.id IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- Auto-satisfy when fully paid
  IF v_delta > 0
     AND v_order.total_owed IS NOT NULL
     AND v_order.total_owed > 0
     AND v_order.total_paid >= v_order.total_owed
     AND v_order.status IN ('active','approved')
  THEN
    UPDATE public.employee_garnishments
       SET status = 'satisfied'::garnishment_status,
           status_changed_at = now(),
           status_changed_by = v_actor,
           status_reason = 'Auto-satisfied: total_paid reached total_owed',
           is_active = false,
           updated_at = now()
     WHERE id = v_garn_id;

    INSERT INTO public.garnishment_lifecycle_events
      (organization_id, business_id, garnishment_id, event,
       from_status, to_status, reason_code, reason_text,
       payload, effective_at, actor_user_id)
    VALUES (v_org, v_order.business_id, v_garn_id, 'satisfied',
            v_order.status, 'satisfied'::garnishment_status,
            'auto_satisfied',
            'Garnishment fully paid via remittance allocation',
            jsonb_build_object(
              'total_paid', v_order.total_paid,
              'total_owed', v_order.total_owed,
              'trigger', TG_OP
            ),
            now(), v_actor);
  END IF;

  RETURN COALESCE(NEW, OLD);
END
$$;

DROP TRIGGER IF EXISTS trg_apply_garnishment_payment_to_order
  ON public.payroll_remittance_payment_allocations;

CREATE TRIGGER trg_apply_garnishment_payment_to_order
AFTER INSERT OR UPDATE OR DELETE ON public.payroll_remittance_payment_allocations
FOR EACH ROW EXECUTE FUNCTION public.apply_garnishment_payment_to_order();
