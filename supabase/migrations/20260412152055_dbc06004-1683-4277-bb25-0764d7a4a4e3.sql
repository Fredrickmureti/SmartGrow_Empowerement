-- Step 1: Drop and recreate valid_device_role with kitchen_printer
ALTER TABLE public.pos_hardware_configs DROP CONSTRAINT valid_device_role;
ALTER TABLE public.pos_hardware_configs ADD CONSTRAINT valid_device_role
  CHECK (device_role IS NULL OR device_role = ANY (ARRAY[
    'receipt_printer','label_printer','kitchen_printer',
    'cash_drawer','scale','customer_display',
    'barcode_scanner','payment_terminal'
  ]));

-- Step 2: Drop and recreate valid_driver_type with epos_printer
ALTER TABLE public.pos_hardware_configs DROP CONSTRAINT valid_driver_type;
ALTER TABLE public.pos_hardware_configs ADD CONSTRAINT valid_driver_type
  CHECK (driver_type IS NULL OR driver_type = ANY (ARRAY[
    'escpos','star','citizen','bixolon','epson','epos_printer',
    'escpos_drawer','generic_scale','toledo_scale','cas_scale','mettler_scale',
    'secondary_screen_display','browser_print',
    'worldline_terminal','adyen_terminal','generic_terminal',
    'keyboard_scanner','hid_scanner','line_display'
  ]));

-- Step 3: Drop and recreate valid_device_status with unreachable + configured
ALTER TABLE public.pos_hardware_configs DROP CONSTRAINT valid_device_status;
ALTER TABLE public.pos_hardware_configs ADD CONSTRAINT valid_device_status
  CHECK (status = ANY (ARRAY[
    'online','offline','unknown','error','configuring','unreachable','configured'
  ]));