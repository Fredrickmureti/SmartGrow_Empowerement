-- Phase F fix: the AP outbox emitters wrote source = 'ap', which is not a member
-- of the event_source_domain domain. The domain check rejected the insert, so
-- EVERY bill status transition and EVERY bill payment aborted. Use 'purchasing',
-- the canonical AP-side domain value (mirrors _pret_log).
CREATE OR REPLACE FUNCTION public._emit_bill_lifecycle_outbox()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
  INSERT INTO public.business_event_outbox (
    org_id, branch_id, event_type, source_doc_type, source_doc_id, payload,
    idempotency_key, actor_user_id, source)
  VALUES (NEW.organization_id, NEW.branch_id,
          'bill.' || NEW.status::text, 'bill', NEW.id,
          jsonb_build_object('business_id', NEW.business_id, 'vendor_id', NEW.vendor_id,
                             'status', NEW.status, 'total', NEW.total, 'currency', NEW.currency),
          'bill.' || NEW.status::text || ':' || NEW.id::text, auth.uid(), 'purchasing')
  ON CONFLICT (idempotency_key) DO NOTHING;
  RETURN NEW;
END $function$;

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
                             'amount', NEW.amount, 'currency', NEW.currency),
          'bill_payment.recorded:' || NEW.id::text, auth.uid(), 'purchasing')
  ON CONFLICT (idempotency_key) DO NOTHING;
  RETURN NEW;
END $function$;