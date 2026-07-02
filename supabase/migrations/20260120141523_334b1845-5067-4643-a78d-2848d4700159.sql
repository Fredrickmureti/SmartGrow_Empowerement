-- Drop existing triggers if any
DROP TRIGGER IF EXISTS automation_trigger_invoices ON public.invoices;
DROP TRIGGER IF EXISTS automation_trigger_contacts ON public.contacts;
DROP TRIGGER IF EXISTS automation_trigger_products ON public.products;
DROP TRIGGER IF EXISTS automation_trigger_sales_orders ON public.sales_orders;
DROP TRIGGER IF EXISTS automation_trigger_purchase_orders ON public.purchase_orders;
DROP TRIGGER IF EXISTS automation_trigger_bills ON public.bills;
DROP TRIGGER IF EXISTS automation_trigger_expenses ON public.expenses;
DROP TRIGGER IF EXISTS automation_trigger_journal_entries ON public.journal_entries;
DROP TRIGGER IF EXISTS automation_trigger_crm_leads ON public.crm_leads;
DROP TRIGGER IF EXISTS automation_trigger_fixed_assets ON public.fixed_assets;

-- Create or replace the automation processor function with proper search_path
CREATE OR REPLACE FUNCTION public.trigger_automation_processor()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  payload jsonb;
  record_data jsonb;
  old_record_data jsonb;
BEGIN
  -- Build the record data based on operation
  IF TG_OP = 'DELETE' THEN
    record_data := to_jsonb(OLD);
    old_record_data := to_jsonb(OLD);
  ELSIF TG_OP = 'UPDATE' THEN
    record_data := to_jsonb(NEW);
    old_record_data := to_jsonb(OLD);
  ELSE
    record_data := to_jsonb(NEW);
    old_record_data := NULL;
  END IF;

  -- Build payload for the edge function
  payload := jsonb_build_object(
    'table_name', TG_TABLE_NAME,
    'operation', TG_OP,
    'record', record_data,
    'old_record', old_record_data,
    'timestamp', now()
  );

  -- Call the edge function asynchronously using pg_net if available
  -- For now, we'll use a simpler approach that doesn't block
  PERFORM pg_notify('automation_events', payload::text);

  -- Return appropriate value based on operation
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  ELSE
    RETURN NEW;
  END IF;
END;
$$;

-- Create triggers on all entity tables
CREATE TRIGGER automation_trigger_invoices
  AFTER INSERT OR UPDATE OR DELETE ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.trigger_automation_processor();

CREATE TRIGGER automation_trigger_contacts
  AFTER INSERT OR UPDATE OR DELETE ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public.trigger_automation_processor();

CREATE TRIGGER automation_trigger_products
  AFTER INSERT OR UPDATE OR DELETE ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.trigger_automation_processor();

CREATE TRIGGER automation_trigger_sales_orders
  AFTER INSERT OR UPDATE OR DELETE ON public.sales_orders
  FOR EACH ROW EXECUTE FUNCTION public.trigger_automation_processor();

CREATE TRIGGER automation_trigger_purchase_orders
  AFTER INSERT OR UPDATE OR DELETE ON public.purchase_orders
  FOR EACH ROW EXECUTE FUNCTION public.trigger_automation_processor();

CREATE TRIGGER automation_trigger_bills
  AFTER INSERT OR UPDATE OR DELETE ON public.bills
  FOR EACH ROW EXECUTE FUNCTION public.trigger_automation_processor();

CREATE TRIGGER automation_trigger_expenses
  AFTER INSERT OR UPDATE OR DELETE ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public.trigger_automation_processor();

CREATE TRIGGER automation_trigger_journal_entries
  AFTER INSERT OR UPDATE OR DELETE ON public.journal_entries
  FOR EACH ROW EXECUTE FUNCTION public.trigger_automation_processor();

CREATE TRIGGER automation_trigger_crm_leads
  AFTER INSERT OR UPDATE OR DELETE ON public.crm_leads
  FOR EACH ROW EXECUTE FUNCTION public.trigger_automation_processor();

CREATE TRIGGER automation_trigger_fixed_assets
  AFTER INSERT OR UPDATE OR DELETE ON public.fixed_assets
  FOR EACH ROW EXECUTE FUNCTION public.trigger_automation_processor();

-- Fix search_path on other security-sensitive functions
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;