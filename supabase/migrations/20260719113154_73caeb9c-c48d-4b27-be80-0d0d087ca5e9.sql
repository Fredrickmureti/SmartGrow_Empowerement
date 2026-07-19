CREATE OR REPLACE FUNCTION public.tg_stock_adjustment_emit_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF COALESCE(NEW.is_sample_data, false) THEN
    RETURN NEW;
  END IF;

  IF NEW.status = 'approved' AND (OLD.status IS DISTINCT FROM 'approved') THEN
    INSERT INTO public.business_event_outbox (
      org_id, branch_id, warehouse_id,
      event_type, source_doc_type, source_doc_id,
      payload, idempotency_key, actor_user_id, source
    ) VALUES (
      NEW.organization_id, NEW.branch_id, NEW.warehouse_id,
      'stock.adjustment.posted', 'stock_adjustment', NEW.id,
      jsonb_build_object(
        'business_id', NEW.business_id,
        'adjustment_number', NEW.adjustment_number,
        'reason', NEW.reason,
        'adjustment_type', NEW.adjustment_type,
        'warehouse_id', NEW.warehouse_id,
        'approved_at', NEW.approved_at
      ),
      'stock.adjustment:' || NEW.id::text,
      COALESCE(NEW.approved_by, NEW.created_by),
      'inventory'
    )
    ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'tg_stock_adjustment_emit_lifecycle failed for %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;