-- Wave 5 — reverse mirror trigger: device_assignments → pos_hardware_configs
-- Forward trigger (pos_hardware_configs → device_assignments) already exists.
-- This adds the reverse direction so canonical writes (via useDeviceAssignments
-- or the platform Hardware page) reflect into the legacy table for any
-- consumer still reading pos_hardware_configs (DeviceRegistryCard,
-- useHardwareProxy). Both triggers use pg_trigger_depth() to break loops.

CREATE OR REPLACE FUNCTION public.device_assignment_to_legacy_mirror()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_hardware_type text;
  v_register_id uuid;
  v_business_id uuid;
BEGIN
  -- Loop guard: forward mirror also writes; only fire on direct user writes.
  IF pg_trigger_depth() > 1 THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- Map canonical role → legacy hardware_type
  v_hardware_type := CASE COALESCE(NEW.role, OLD.role)
    WHEN 'receipt_printer'  THEN 'printer'
    WHEN 'kitchen_printer'  THEN 'printer'
    WHEN 'label_printer'    THEN 'printer'
    WHEN 'cash_drawer'      THEN 'cash_drawer'
    WHEN 'barcode_scanner'  THEN 'barcode_scanner'
    WHEN 'scanner'          THEN 'barcode_scanner'
    WHEN 'customer_display' THEN 'customer_display'
    WHEN 'scale'            THEN 'scale'
    WHEN 'payment_terminal' THEN 'payment_terminal'
    ELSE 'printer'
  END;

  v_register_id := CASE WHEN COALESCE(NEW.scope_kind, OLD.scope_kind) IN ('register','station')
                        THEN COALESCE(NEW.scope_id, OLD.scope_id)::uuid
                        ELSE NULL
                   END;
  v_business_id := COALESCE(NEW.business_id, OLD.business_id);

  IF TG_OP = 'DELETE' THEN
    -- Best-effort delete; legacy row may not exist if the canonical row was
    -- created via the platform path and never mirrored back yet.
    DELETE FROM public.pos_hardware_configs
     WHERE source_assignment_id = OLD.id
        OR id = OLD.source_config_id;
    RETURN OLD;
  END IF;

  -- UPSERT into legacy. Match on source_assignment_id (preferred) or the
  -- existing source_config_id link.
  IF EXISTS (
    SELECT 1 FROM public.pos_hardware_configs
     WHERE source_assignment_id = NEW.id
        OR id = NEW.source_config_id
  ) THEN
    UPDATE public.pos_hardware_configs
       SET display_name      = NEW.display_name,
           hardware_type     = v_hardware_type,
           connection_type   = NEW.transport,
           connection_params = NEW.config,
           device_role       = NEW.role,
           driver_type       = NEW.driver,
           is_active         = NEW.enabled,
           is_default        = NEW.is_default,
           status            = NEW.status,
           last_seen_at      = NEW.last_seen_at,
           last_error        = NEW.last_error,
           register_id       = v_register_id,
           business_id       = v_business_id,
           updated_at        = now()
     WHERE source_assignment_id = NEW.id
        OR id = NEW.source_config_id;
  ELSE
    INSERT INTO public.pos_hardware_configs (
      organization_id, business_id, register_id,
      display_name, hardware_type, connection_type, connection_params,
      device_role, driver_type, is_active, is_default,
      status, last_seen_at, last_error, source_assignment_id
    ) VALUES (
      NEW.organization_id, v_business_id, v_register_id,
      NEW.display_name, v_hardware_type, NEW.transport, NEW.config,
      NEW.role, NEW.driver, NEW.enabled, NEW.is_default,
      NEW.status, NEW.last_seen_at, NEW.last_error, NEW.id
    );
  END IF;

  RETURN NEW;
END;
$$;

-- Add the back-reference column on the legacy table if it doesn't exist.
ALTER TABLE public.pos_hardware_configs
  ADD COLUMN IF NOT EXISTS source_assignment_id uuid
  REFERENCES public.device_assignments(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_pos_hardware_configs_source_assignment
  ON public.pos_hardware_configs (source_assignment_id);

DROP TRIGGER IF EXISTS device_assignment_legacy_mirror ON public.device_assignments;
CREATE TRIGGER device_assignment_legacy_mirror
  AFTER INSERT OR UPDATE OR DELETE ON public.device_assignments
  FOR EACH ROW EXECUTE FUNCTION public.device_assignment_to_legacy_mirror();

COMMENT ON FUNCTION public.device_assignment_to_legacy_mirror IS
  'Wave 5: reverse mirror canonical device_assignments writes back to the legacy pos_hardware_configs table so DeviceRegistryCard and useHardwareProxy stay coherent until they migrate to useDeviceAssignments. Loop-guarded against the forward mirror via pg_trigger_depth().';