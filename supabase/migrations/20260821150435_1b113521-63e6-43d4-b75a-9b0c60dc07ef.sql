-- Phase F fix: _emit_bill_payment_outbox read NEW.currency, a column bill_payments
-- does not have, so every bill payment insert aborted at the trigger. Publish the
-- stored settlement rate instead; the document currency lives on the bills.
CREATE OR REPLACE FUNCTION public._emit_bill_payment_outbox()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO public.business_event_outbox (
    org_id, branch_id, event_type, source_doc_type, source_doc_id, payload,
    idempotency_key, actor_user_id, source)
  VALUES (NEW.organization_id, NEW.branch_id, 'bill_payment.recorded', 'bill_payment', NEW.id,
          jsonb_build_object('business_id', NEW.business_id, 'vendor_id', NEW.vendor_id,
                             'amount', NEW.amount, 'currency_rate', NEW.currency_rate),
          'bill_payment.recorded:' || NEW.id::text, auth.uid(), 'purchasing')
  ON CONFLICT (idempotency_key) DO NOTHING;
  RETURN NEW;
END $function$;