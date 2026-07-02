
-- Drop existing automation triggers if they exist
DROP TRIGGER IF EXISTS automation_trigger_contacts ON public.contacts;
DROP TRIGGER IF EXISTS automation_trigger_invoices ON public.invoices;
DROP TRIGGER IF EXISTS automation_trigger_products ON public.products;
DROP TRIGGER IF EXISTS automation_trigger_sales_orders ON public.sales_orders;
DROP TRIGGER IF EXISTS automation_trigger_purchase_orders ON public.purchase_orders;
DROP TRIGGER IF EXISTS automation_trigger_bills ON public.bills;
DROP TRIGGER IF EXISTS automation_trigger_expenses ON public.expenses;

-- Recreate the function
CREATE OR REPLACE FUNCTION public.invoke_automation_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _org_id uuid;
  _event_type text;
  _record_id text;
  _record_data jsonb;
  _old_data jsonb;
  _supabase_url text;
  _anon_key text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    _event_type := 'on_create';
    _record_data := to_jsonb(NEW);
    _old_data := '{}'::jsonb;
    _record_id := NEW.id::text;
    _org_id := NEW.organization_id;
  ELSIF TG_OP = 'UPDATE' THEN
    _event_type := 'on_update';
    _record_data := to_jsonb(NEW);
    _old_data := to_jsonb(OLD);
    _record_id := NEW.id::text;
    _org_id := NEW.organization_id;
  ELSIF TG_OP = 'DELETE' THEN
    _event_type := 'on_delete';
    _record_data := to_jsonb(OLD);
    _old_data := '{}'::jsonb;
    _record_id := OLD.id::text;
    _org_id := OLD.organization_id;
  END IF;

  IF _org_id IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  _supabase_url := 'https://jkszmrroyjfdwokbkzis.supabase.co';
  _anon_key := 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imprc3ptcnJveWpmZHdva2JremlzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc4MzkwMzEsImV4cCI6MjA4MzQxNTAzMX0.iJjPAh8zaed1XbgKnRZp63JLNU37Z72CJPHlSnEPaQc';

  PERFORM net.http_post(
    url := _supabase_url || '/functions/v1/process-automation',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || _anon_key
    ),
    body := jsonb_build_object(
      'event_type', _event_type,
      'target_model', TG_TABLE_NAME,
      'record_id', _record_id,
      'record_data', _record_data,
      'old_data', _old_data,
      'organization_id', _org_id::text
    )
  );

  RETURN COALESCE(NEW, OLD);
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'invoke_automation_trigger failed: %', SQLERRM;
  RETURN COALESCE(NEW, OLD);
END;
$$;

-- Attach triggers
CREATE TRIGGER automation_trigger_contacts
  AFTER INSERT OR UPDATE OR DELETE ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public.invoke_automation_trigger();

CREATE TRIGGER automation_trigger_invoices
  AFTER INSERT OR UPDATE OR DELETE ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.invoke_automation_trigger();

CREATE TRIGGER automation_trigger_products
  AFTER INSERT OR UPDATE OR DELETE ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.invoke_automation_trigger();

CREATE TRIGGER automation_trigger_sales_orders
  AFTER INSERT OR UPDATE OR DELETE ON public.sales_orders
  FOR EACH ROW EXECUTE FUNCTION public.invoke_automation_trigger();

CREATE TRIGGER automation_trigger_purchase_orders
  AFTER INSERT OR UPDATE OR DELETE ON public.purchase_orders
  FOR EACH ROW EXECUTE FUNCTION public.invoke_automation_trigger();

CREATE TRIGGER automation_trigger_bills
  AFTER INSERT OR UPDATE OR DELETE ON public.bills
  FOR EACH ROW EXECUTE FUNCTION public.invoke_automation_trigger();

CREATE TRIGGER automation_trigger_expenses
  AFTER INSERT OR UPDATE OR DELETE ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public.invoke_automation_trigger();

-- ============= Approval Rules =============
CREATE TABLE IF NOT EXISTS public.approval_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  entity_type text NOT NULL,
  action_name text NOT NULL,
  description text,
  is_active boolean NOT NULL DEFAULT true,
  condition jsonb DEFAULT '{}'::jsonb,
  approver_type text NOT NULL DEFAULT 'specific_user',
  approver_user_id uuid,
  approver_role text,
  approval_mode text NOT NULL DEFAULT 'any',
  threshold_field text,
  threshold_operator text,
  threshold_value numeric,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid
);

ALTER TABLE public.approval_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Org members can view approval rules"
  ON public.approval_rules FOR SELECT TO authenticated
  USING (organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()));

CREATE POLICY "Org members can manage approval rules"
  ON public.approval_rules FOR ALL TO authenticated
  USING (organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()))
  WITH CHECK (organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()));

-- ============= Approval Rule Logs =============
CREATE TABLE IF NOT EXISTS public.approval_rule_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id uuid NOT NULL REFERENCES public.approval_rules(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  action_name text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  requested_by uuid,
  approved_by uuid,
  approved_at timestamptz,
  rejected_by uuid,
  rejected_at timestamptz,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.approval_rule_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Org members can view approval logs"
  ON public.approval_rule_logs FOR SELECT TO authenticated
  USING (organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()));

CREATE POLICY "Org members can manage approval logs"
  ON public.approval_rule_logs FOR ALL TO authenticated
  USING (organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()))
  WITH CHECK (organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()));

-- ============= Report Field Configs =============
CREATE TABLE IF NOT EXISTS public.report_field_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  entity_type text NOT NULL,
  report_type text NOT NULL DEFAULT 'pdf',
  included_core_fields text[] DEFAULT '{}',
  included_custom_fields text[] DEFAULT '{}',
  field_order text[] DEFAULT '{}',
  header_fields text[] DEFAULT '{}',
  footer_fields text[] DEFAULT '{}',
  is_default boolean NOT NULL DEFAULT false,
  config_name text NOT NULL DEFAULT 'Default',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid
);

ALTER TABLE public.report_field_configs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Org members can view report configs"
  ON public.report_field_configs FOR SELECT TO authenticated
  USING (organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()));

CREATE POLICY "Org members can manage report configs"
  ON public.report_field_configs FOR ALL TO authenticated
  USING (organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()))
  WITH CHECK (organization_id IN (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()));

-- Updated_at triggers for new tables
CREATE TRIGGER update_approval_rules_updated_at
  BEFORE UPDATE ON public.approval_rules
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_report_field_configs_updated_at
  BEFORE UPDATE ON public.report_field_configs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
