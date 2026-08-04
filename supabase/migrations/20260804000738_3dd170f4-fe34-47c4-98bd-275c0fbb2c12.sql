-- Phase 1a: canonical exception vocabulary.
-- Enum value additions must be committed before any object can reference
-- them, so this migration is deliberately enum-only.

-- ---------------------------------------------------------------- kinds
DO $$
DECLARE v text;
BEGIN
  FOREACH v IN ARRAY ARRAY[
    -- inbound / receiving
    'over_receipt','under_receipt','missing_carton','wrong_supplier','wrong_asn',
    'damaged_goods','failed_inspection','asn_mismatch',
    -- inventory accuracy
    'negative_inventory','phantom_inventory','duplicate_serial','batch_mismatch',
    'expired_stock','unexpected_movement',
    -- storage / bins
    'wrong_location','unsafe_storage','quarantine_violation',
    -- picking
    'wrong_item_picked','wrong_batch_picked','pick_sla_breach',
    -- packing
    'weight_mismatch','incorrect_package','carton_missing',
    -- shipping
    'wrong_carrier','missed_dispatch','shipment_blocked',
    -- dock
    'missed_appointment','dock_congestion','incorrect_trailer',
    -- yard
    'trailer_overstay','seal_mismatch',
    -- cross-dock
    'demand_disappeared','routing_conflict',
    -- counting
    'repeated_discrepancy',
    -- labour
    'abandoned_task','productivity_target_missed',
    -- equipment / hardware
    'device_offline','printer_offline','scanner_offline','rfid_failure',
    'conveyor_failure','scale_failure','sensor_failure',
    -- returns
    'return_discrepancy',
    -- integrations
    'integration_failure','data_sync_failure'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'wms_exception_kind' AND e.enumlabel = v
    ) THEN
      EXECUTE format('ALTER TYPE public.wms_exception_kind ADD VALUE %L', v);
    END IF;
  END LOOP;
END $$;

-- ------------------------------------------------- resolution cause codes
DO $$
DECLARE v text;
BEGIN
  FOREACH v IN ARRAY ARRAY[
    'supplier_error','carrier_error','operator_error','equipment_failure',
    'integration_error','data_entry_error','theft_or_loss','expiry',
    'no_fault_found','duplicate_exception'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'wms_exception_resolution_kind' AND e.enumlabel = v
    ) THEN
      EXECUTE format('ALTER TYPE public.wms_exception_resolution_kind ADD VALUE %L', v);
    END IF;
  END LOOP;
END $$;

-- --------------------------------------------------------------- classes
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'wms_exception_class') THEN
    CREATE TYPE public.wms_exception_class AS ENUM (
      'informational','operational','quality','safety','compliance',
      'financial','customer_impact'
    );
  END IF;
END $$;

-- ------------------------------------------------- lifecycle event types
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'wms_exception_event_type') THEN
    CREATE TYPE public.wms_exception_event_type AS ENUM (
      'created','classified','assigned','reassigned','acknowledged',
      'state_changed','evidence_added','link_added','comment_added',
      'escalated','sla_breached','resolved','closed','reopened'
    );
  END IF;
END $$;

-- ---------------------------------------------------------- evidence kinds
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'wms_exception_evidence_type') THEN
    CREATE TYPE public.wms_exception_evidence_type AS ENUM (
      'barcode_scan','rfid_read','photo','signature','weight','dimension',
      'temperature','humidity','sensor_reading','inspection_report',
      'supplier_document','system_snapshot','external_reference','note'
    );
  END IF;
END $$;

-- ------------------------------------------------------- document links
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'wms_exception_link_type') THEN
    CREATE TYPE public.wms_exception_link_type AS ENUM (
      'goods_receipt','purchase_order','asn','receiving_session','count_session',
      'qc_inspection','pick_wave','manifest','delivery_note','invoice','bill',
      'task','license_plate','return_order','dock_appointment','trailer_visit',
      'product','supplier','carrier','operator','warehouse_location','other'
    );
  END IF;
END $$;

-- --------------------------------------------------------- owner roles
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'wms_exception_owner_role') THEN
    CREATE TYPE public.wms_exception_owner_role AS ENUM (
      'warehouse_supervisor','receiving_lead','inventory_controller',
      'quality_inspector','pick_lead','pack_lead','shipping_lead',
      'dock_coordinator','yard_marshal','maintenance','labour_planner',
      'finance','procurement','it_support'
    );
  END IF;
END $$;
