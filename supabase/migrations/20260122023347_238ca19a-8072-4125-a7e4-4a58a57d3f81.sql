-- Fix the log_document_activity function to properly cast enum to text before COALESCE
CREATE OR REPLACE FUNCTION public.log_document_activity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_entity_type TEXT;
  v_entity_name TEXT;
  v_content TEXT;
  v_metadata JSONB;
BEGIN
  v_entity_type := TG_TABLE_NAME;
  
  IF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN
    -- FIX: Cast status to TEXT before COALESCE to avoid enum casting error
    v_content := 'Status changed from ' || COALESCE(OLD.status::TEXT, 'none') || ' to ' || NEW.status::TEXT;
    v_metadata := jsonb_build_object(
      'old_status', OLD.status::TEXT,
      'new_status', NEW.status::TEXT,
      'changed_at', now()
    );
    
    -- Get entity name based on table
    IF TG_TABLE_NAME = 'invoices' THEN
      v_entity_name := NEW.invoice_number;
    ELSIF TG_TABLE_NAME = 'bills' THEN
      v_entity_name := NEW.bill_number;
    ELSIF TG_TABLE_NAME = 'estimates' THEN
      v_entity_name := NEW.estimate_number;
    ELSIF TG_TABLE_NAME = 'sales_orders' THEN
      v_entity_name := NEW.so_number;
    ELSIF TG_TABLE_NAME = 'purchase_orders' THEN
      v_entity_name := NEW.po_number;
    END IF;
    
    INSERT INTO document_comments (
      organization_id,
      entity_type,
      entity_id,
      comment_type,
      content,
      metadata,
      is_internal
    ) VALUES (
      NEW.organization_id,
      v_entity_type,
      NEW.id,
      'status_change',
      v_content,
      v_metadata,
      true
    );
  END IF;
  
  RETURN NEW;
END;
$$;