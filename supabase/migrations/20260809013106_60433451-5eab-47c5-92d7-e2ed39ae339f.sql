CREATE OR REPLACE FUNCTION public.sales_order_governed_write_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_stack text;
  v_owned boolean;
  v_changed text[] := ARRAY[]::text[];
BEGIN
  IF public._is_teardown_for_org(COALESCE(NEW.organization_id, OLD.organization_id)) THEN
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    v_changed := array_append(v_changed, 'status');
  END IF;
  IF NEW.so_number IS DISTINCT FROM OLD.so_number THEN
    v_changed := array_append(v_changed, 'so_number');
  END IF;
  IF NEW.subtotal IS DISTINCT FROM OLD.subtotal
     OR NEW.tax_amount IS DISTINCT FROM OLD.tax_amount
     OR NEW.discount_amount IS DISTINCT FROM OLD.discount_amount
     OR NEW.shipping_amount IS DISTINCT FROM OLD.shipping_amount
     OR NEW.total IS DISTINCT FROM OLD.total THEN
    v_changed := array_append(v_changed, 'totals');
  END IF;
  IF NEW.exchange_rate IS DISTINCT FROM OLD.exchange_rate THEN
    v_changed := array_append(v_changed, 'exchange_rate');
  END IF;
  IF NEW.converted_invoice_id IS DISTINCT FROM OLD.converted_invoice_id THEN
    v_changed := array_append(v_changed, 'converted_invoice_id');
  END IF;
  IF NEW.is_locked IS DISTINCT FROM OLD.is_locked THEN
    v_changed := array_append(v_changed, 'is_locked');
  END IF;

  IF array_length(v_changed, 1) IS NULL THEN
    RETURN NEW;
  END IF;

  GET DIAGNOSTICS v_stack = PG_CONTEXT;

  v_owned :=
       v_stack ILIKE '%create_sales_order_atomic%'
    OR v_stack ILIKE '%update_sales_order_atomic%'
    OR v_stack ILIKE '%confirm_sales_order_atomic%'
    OR v_stack ILIKE '%cancel_sales_order_atomic%'
    OR v_stack ILIKE '%set_sales_order_approval_state_atomic%'
    OR v_stack ILIKE '%convert_so_to_invoice_atomic%'
    OR v_stack ILIKE '%create_invoice_from_delivery_atomic%'
    OR v_stack ILIKE '%complete_delivery_atomic%'
    OR v_stack ILIKE '%cancel_delivery_atomic%'
    OR v_stack ILIKE '%create_delivery_from_sales_order_atomic%'
    OR v_stack ILIKE '%lock_sales_order_on_dn_invoice%'
    OR v_stack ILIKE '%lock_sales_order_on_invoice_link%'
    OR v_stack ILIKE '%convert_estimate_to_so_atomic%'
    OR v_stack ILIKE '%convert_lead_to_sales_order%'
    OR v_stack ILIKE '%_execute_organization_delete%';

  IF NOT v_owned THEN
    RAISE EXCEPTION
      'Sales order % — % may only be changed by the sales-order engines (confirm_sales_order_atomic, cancel_sales_order_atomic, set_sales_order_approval_state_atomic, update_sales_order_atomic or the invoicing/delivery routes). Direct writes are rejected.',
      COALESCE(NEW.so_number, OLD.so_number), array_to_string(v_changed, ', ')
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$function$;