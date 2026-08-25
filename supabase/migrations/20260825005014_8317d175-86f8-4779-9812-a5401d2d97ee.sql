-- 1. Lead items: business is mandatory
ALTER TABLE public.crm_lead_items ALTER COLUMN business_id SET NOT NULL;

-- 2. Composite integrity: an item's business must equal its lead's business
ALTER TABLE public.crm_leads ADD CONSTRAINT crm_leads_id_business_key UNIQUE (id, business_id);
ALTER TABLE public.crm_lead_items DROP CONSTRAINT IF EXISTS crm_lead_items_lead_id_fkey;
ALTER TABLE public.crm_lead_items
  ADD CONSTRAINT crm_lead_items_lead_business_fkey
  FOREIGN KEY (lead_id, business_id) REFERENCES public.crm_leads(id, business_id) ON DELETE CASCADE;

-- 3. Product must belong to the item's business
CREATE OR REPLACE FUNCTION public._crm_lead_item_product_business_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_product_business uuid;
BEGIN
  IF NEW.product_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT business_id INTO v_product_business FROM public.products WHERE id = NEW.product_id;
  IF v_product_business IS NULL OR v_product_business <> NEW.business_id THEN
    RAISE EXCEPTION 'CRM lead item product % does not belong to business %', NEW.product_id, NEW.business_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS crm_lead_item_product_business_guard ON public.crm_lead_items;
CREATE TRIGGER crm_lead_item_product_business_guard
  BEFORE INSERT OR UPDATE OF product_id, business_id ON public.crm_lead_items
  FOR EACH ROW EXECUTE FUNCTION public._crm_lead_item_product_business_guard();

-- 4. History table: least privilege (append happens via SECURITY DEFINER trigger)
REVOKE ALL ON public.crm_lead_history FROM anon;
REVOKE ALL ON public.crm_lead_history FROM authenticated;
GRANT SELECT ON public.crm_lead_history TO authenticated;
GRANT ALL ON public.crm_lead_history TO service_role;

-- 5. Event topic honesty: distinguish "no consumer yet" from "intentionally external"
ALTER TABLE public.business_event_topics
  ADD COLUMN IF NOT EXISTS integration_only boolean NOT NULL DEFAULT false;

UPDATE public.business_event_topics
SET integration_only = true,
    description = COALESCE(description, '') ||
      CASE WHEN COALESCE(description, '') = '' THEN '' ELSE ' ' END ||
      '(Integration-only: recorded for external subscribers and audit; no internal consumer domain reacts to it.)'
WHERE topic_prefix LIKE 'crm.lead.%'
  AND (consumer_domains IS NULL OR cardinality(consumer_domains) = 0)
  AND integration_only = false;