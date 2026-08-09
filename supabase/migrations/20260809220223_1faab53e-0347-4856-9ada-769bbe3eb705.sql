-- Sales: the customer address the document ships to.
ALTER TABLE public.sales_orders
  ADD COLUMN IF NOT EXISTS ship_to_contact_id uuid NULL REFERENCES public.contacts(id) ON DELETE SET NULL;

ALTER TABLE public.delivery_notes
  ADD COLUMN IF NOT EXISTS ship_to_contact_id uuid NULL REFERENCES public.contacts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_sales_orders_ship_to ON public.sales_orders (ship_to_contact_id);
CREATE INDEX IF NOT EXISTS idx_delivery_notes_ship_to ON public.delivery_notes (ship_to_contact_id);

-- Purchasing: OUR receiving destination (never a supplier address).
ALTER TABLE public.purchase_orders
  ADD COLUMN IF NOT EXISTS deliver_to_warehouse_id uuid NULL REFERENCES public.warehouses(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS deliver_to_branch_id uuid NULL REFERENCES public.branches(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_purchase_orders_deliver_to_wh ON public.purchase_orders (deliver_to_warehouse_id);

-- Server-side guard: the ship-to address must belong to the same business
-- as the document, and to the document's own counterparty family.
CREATE OR REPLACE FUNCTION public._assert_ship_to_contact_valid()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_addr_business uuid;
  v_addr_root uuid;
  v_doc_root uuid;
BEGIN
  IF NEW.ship_to_contact_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT business_id, COALESCE(parent_contact_id, id)
    INTO v_addr_business, v_addr_root
    FROM public.contacts
   WHERE id = NEW.ship_to_contact_id;

  IF v_addr_business IS NULL THEN
    RAISE EXCEPTION 'Ship-to address % does not exist', NEW.ship_to_contact_id;
  END IF;

  IF NEW.business_id IS NOT NULL AND v_addr_business <> NEW.business_id THEN
    RAISE EXCEPTION 'Ship-to address belongs to another business';
  END IF;

  IF NEW.contact_id IS NOT NULL THEN
    SELECT COALESCE(parent_contact_id, id) INTO v_doc_root
      FROM public.contacts WHERE id = NEW.contact_id;
    IF v_doc_root IS NOT NULL AND v_addr_root <> v_doc_root THEN
      RAISE EXCEPTION 'Ship-to address does not belong to this customer';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sales_orders_ship_to_valid ON public.sales_orders;
CREATE TRIGGER trg_sales_orders_ship_to_valid
  BEFORE INSERT OR UPDATE OF ship_to_contact_id ON public.sales_orders
  FOR EACH ROW EXECUTE FUNCTION public._assert_ship_to_contact_valid();

DROP TRIGGER IF EXISTS trg_delivery_notes_ship_to_valid ON public.delivery_notes;
CREATE TRIGGER trg_delivery_notes_ship_to_valid
  BEFORE INSERT OR UPDATE OF ship_to_contact_id ON public.delivery_notes
  FOR EACH ROW EXECUTE FUNCTION public._assert_ship_to_contact_valid();

-- Server-side guard: the PO receiving destination must be ours.
CREATE OR REPLACE FUNCTION public._assert_po_destination_valid()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_business uuid;
BEGIN
  IF NEW.deliver_to_warehouse_id IS NOT NULL THEN
    SELECT business_id INTO v_business FROM public.warehouses WHERE id = NEW.deliver_to_warehouse_id;
    IF v_business IS NULL OR (NEW.business_id IS NOT NULL AND v_business <> NEW.business_id) THEN
      RAISE EXCEPTION 'Receiving warehouse belongs to another business';
    END IF;
  END IF;

  IF NEW.deliver_to_branch_id IS NOT NULL THEN
    SELECT business_id INTO v_business FROM public.branches WHERE id = NEW.deliver_to_branch_id;
    IF v_business IS NULL OR (NEW.business_id IS NOT NULL AND v_business <> NEW.business_id) THEN
      RAISE EXCEPTION 'Receiving branch belongs to another business';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_purchase_orders_destination_valid ON public.purchase_orders;
CREATE TRIGGER trg_purchase_orders_destination_valid
  BEFORE INSERT OR UPDATE OF deliver_to_warehouse_id, deliver_to_branch_id ON public.purchase_orders
  FOR EACH ROW EXECUTE FUNCTION public._assert_po_destination_valid();