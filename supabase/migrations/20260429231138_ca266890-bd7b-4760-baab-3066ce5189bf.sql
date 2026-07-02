-- Stage 7: Enforce internal-only recipients for inventory event types.
-- Inventory alerts (low_stock_alert, out_of_stock) must never be sent to customers/vendors;
-- they are operational notifications for staff only.

CREATE OR REPLACE FUNCTION public.tg_enforce_inventory_sms_internal_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.event_type IN ('low_stock_alert', 'out_of_stock')
     AND NEW.recipient_type IN ('customer', 'vendor') THEN
    RAISE EXCEPTION 'Inventory event % cannot use recipient_type %; only internal/employee/role/group recipients are permitted',
      NEW.event_type, NEW.recipient_type;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_inventory_sms_internal_only ON public.sms_event_rules;
CREATE TRIGGER trg_enforce_inventory_sms_internal_only
BEFORE INSERT OR UPDATE ON public.sms_event_rules
FOR EACH ROW EXECUTE FUNCTION public.tg_enforce_inventory_sms_internal_only();

-- Defensive: also block configuring contact-bearing recipients on inventory rules.
CREATE OR REPLACE FUNCTION public.tg_enforce_inventory_recipient_kind()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_event public.sms_event_type;
BEGIN
  SELECT event_type INTO v_event FROM public.sms_event_rules WHERE id = NEW.rule_id;
  IF v_event IN ('low_stock_alert', 'out_of_stock')
     AND NEW.recipient_kind IN ('contact') THEN
    RAISE EXCEPTION 'Inventory event % cannot have contact recipients; only phone/user/role/group are permitted', v_event;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_inventory_recipient_kind ON public.sms_event_rule_recipients;
CREATE TRIGGER trg_enforce_inventory_recipient_kind
BEFORE INSERT OR UPDATE ON public.sms_event_rule_recipients
FOR EACH ROW EXECUTE FUNCTION public.tg_enforce_inventory_recipient_kind();