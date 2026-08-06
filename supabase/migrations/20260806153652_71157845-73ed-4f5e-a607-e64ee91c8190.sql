-- ADR 0027 follow-up: payments.invoice_id was dropped; these triggers never repointed.

DROP TRIGGER IF EXISTS trigger_notify_payment_received ON public.payments;

CREATE OR REPLACE FUNCTION public.notify_payment_received()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_label text;
  v_count int;
  org_users UUID[];
  customer_name TEXT;
BEGIN
  SELECT count(*), min(i.invoice_number)
    INTO v_count, v_label
  FROM public.payment_allocations pa
  JOIN public.invoices i ON i.id = pa.invoice_id
  WHERE pa.payment_id = NEW.id;

  IF COALESCE(v_count, 0) = 0 THEN
    v_label := 'unapplied advance';
  ELSIF v_count > 1 THEN
    v_label := v_count::text || ' invoices';
  END IF;

  SELECT c.name INTO customer_name
  FROM public.contacts c WHERE c.id = NEW.contact_id;

  SELECT ARRAY_AGG(user_id) INTO org_users
  FROM public.user_roles
  WHERE organization_id = NEW.organization_id
    AND is_active = true;

  IF org_users IS NOT NULL THEN
    INSERT INTO public.notifications (user_id, category, title, message, link, organization_id)
    SELECT
      unnest(org_users),
      'payment',
      'Payment Received',
      'Payment of ' || NEW.amount::TEXT || ' received from '
        || COALESCE(customer_name, 'Customer') || ' (' || v_label || ')',
      '/sales/payments',
      NEW.organization_id;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_sms_payment_received()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_vars jsonb;
  v_invoice_number text;
  v_currency text;
  v_count int;
BEGIN
  IF NOT (
    (TG_OP = 'INSERT' AND NEW.status::text IN ('succeeded','completed','paid','received'))
    OR (TG_OP = 'UPDATE' AND NEW.status::text IN ('succeeded','completed','paid','received')
        AND COALESCE(OLD.status::text,'') NOT IN ('succeeded','completed','paid','received'))
  ) THEN
    RETURN NEW;
  END IF;

  SELECT count(*), min(i.invoice_number), min(i.currency)
    INTO v_count, v_invoice_number, v_currency
  FROM public.payment_allocations pa
  JOIN public.invoices i ON i.id = pa.invoice_id
  WHERE pa.payment_id = NEW.id;

  IF COALESCE(v_count, 0) <> 1 THEN
    v_invoice_number := NULL;
  END IF;

  v_vars := public.sms_build_doc_vars(
    NEW.organization_id, NEW.business_id, NULL, NEW.contact_id,
    v_invoice_number, NEW.amount, v_currency, NULL,
    jsonb_build_object(
      'invoice_number', COALESCE(v_invoice_number,''),
      'reference',      COALESCE(NEW.reference,''),
      'payment_date',   COALESCE(NEW.payment_date::text, '')
    )
  );

  PERFORM public.sms_enqueue_event(
    NEW.organization_id, NEW.business_id, 'payment_received'::sms_event_type,
    'payment', NEW.id, NEW.contact_id, v_vars
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'trg_sms_payment_received failed: %', SQLERRM;
  RETURN NEW;
END;
$function$;