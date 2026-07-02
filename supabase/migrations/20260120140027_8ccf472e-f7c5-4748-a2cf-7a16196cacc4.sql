-- Enable pg_net extension for HTTP calls from triggers
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- Create function to invoke automation processing
CREATE OR REPLACE FUNCTION public.trigger_automation_processor()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_event_type TEXT;
  v_record_data JSONB;
  v_organization_id UUID;
  v_edge_function_url TEXT;
BEGIN
  -- Determine event type
  CASE TG_OP
    WHEN 'INSERT' THEN v_event_type := 'on_create';
    WHEN 'UPDATE' THEN v_event_type := 'on_update';
    WHEN 'DELETE' THEN v_event_type := 'on_delete';
  END CASE;
  
  -- Get record data and organization_id
  IF TG_OP = 'DELETE' THEN
    v_record_data := to_jsonb(OLD);
    v_organization_id := OLD.organization_id;
  ELSE
    v_record_data := to_jsonb(NEW);
    v_organization_id := NEW.organization_id;
  END IF;
  
  -- Check if there are any active automations for this model and trigger type
  IF EXISTS (
    SELECT 1 FROM public.automated_actions
    WHERE target_model = TG_TABLE_NAME
      AND trigger_type = v_event_type
      AND is_active = true
      AND organization_id = v_organization_id
  ) THEN
    -- Build the Edge Function URL
    v_edge_function_url := 'https://jkszmrroyjfdwokbkzis.supabase.co/functions/v1/process-automation';
    
    -- Call the Edge Function asynchronously using pg_net
    PERFORM net.http_post(
      url := v_edge_function_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imprc3ptcnJveWpmZHdva2JremlzIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NzgzOTAzMSwiZXhwIjoyMDgzNDE1MDMxfQ.RnGhVkwPVdB0n0BVVmQs-0K7uKZ2SCSXG1bIX7_7GjE'
      ),
      body := jsonb_build_object(
        'event_type', v_event_type,
        'target_model', TG_TABLE_NAME,
        'record_id', CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END,
        'record_data', v_record_data,
        'old_data', CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE NULL END,
        'organization_id', v_organization_id
      )
    );
  END IF;
  
  -- Return the appropriate value
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  ELSE
    RETURN NEW;
  END IF;
END;
$$;

-- Create triggers for invoices
DROP TRIGGER IF EXISTS automation_trigger_invoices ON public.invoices;
CREATE TRIGGER automation_trigger_invoices
  AFTER INSERT OR UPDATE OR DELETE ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.trigger_automation_processor();

-- Create triggers for contacts
DROP TRIGGER IF EXISTS automation_trigger_contacts ON public.contacts;
CREATE TRIGGER automation_trigger_contacts
  AFTER INSERT OR UPDATE OR DELETE ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public.trigger_automation_processor();

-- Create triggers for products
DROP TRIGGER IF EXISTS automation_trigger_products ON public.products;
CREATE TRIGGER automation_trigger_products
  AFTER INSERT OR UPDATE OR DELETE ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.trigger_automation_processor();

-- Create triggers for estimates
DROP TRIGGER IF EXISTS automation_trigger_estimates ON public.estimates;
CREATE TRIGGER automation_trigger_estimates
  AFTER INSERT OR UPDATE OR DELETE ON public.estimates
  FOR EACH ROW EXECUTE FUNCTION public.trigger_automation_processor();

-- Create triggers for expenses
DROP TRIGGER IF EXISTS automation_trigger_expenses ON public.expenses;
CREATE TRIGGER automation_trigger_expenses
  AFTER INSERT OR UPDATE OR DELETE ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public.trigger_automation_processor();

-- Create triggers for bills
DROP TRIGGER IF EXISTS automation_trigger_bills ON public.bills;
CREATE TRIGGER automation_trigger_bills
  AFTER INSERT OR UPDATE OR DELETE ON public.bills
  FOR EACH ROW EXECUTE FUNCTION public.trigger_automation_processor();

-- Create triggers for sales_orders
DROP TRIGGER IF EXISTS automation_trigger_sales_orders ON public.sales_orders;
CREATE TRIGGER automation_trigger_sales_orders
  AFTER INSERT OR UPDATE OR DELETE ON public.sales_orders
  FOR EACH ROW EXECUTE FUNCTION public.trigger_automation_processor();

-- Create triggers for purchase_orders
DROP TRIGGER IF EXISTS automation_trigger_purchase_orders ON public.purchase_orders;
CREATE TRIGGER automation_trigger_purchase_orders
  AFTER INSERT OR UPDATE OR DELETE ON public.purchase_orders
  FOR EACH ROW EXECUTE FUNCTION public.trigger_automation_processor();

-- Create triggers for crm_leads
DROP TRIGGER IF EXISTS automation_trigger_crm_leads ON public.crm_leads;
CREATE TRIGGER automation_trigger_crm_leads
  AFTER INSERT OR UPDATE OR DELETE ON public.crm_leads
  FOR EACH ROW EXECUTE FUNCTION public.trigger_automation_processor();

-- Create triggers for projects
DROP TRIGGER IF EXISTS automation_trigger_projects ON public.projects;
CREATE TRIGGER automation_trigger_projects
  AFTER INSERT OR UPDATE OR DELETE ON public.projects
  FOR EACH ROW EXECUTE FUNCTION public.trigger_automation_processor();