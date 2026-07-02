-- Drop and recreate the hardware_type check constraint to include 'payment_terminal'
ALTER TABLE public.pos_hardware_configs
  DROP CONSTRAINT IF EXISTS pos_hardware_configs_hardware_type_check;

ALTER TABLE public.pos_hardware_configs
  ADD CONSTRAINT pos_hardware_configs_hardware_type_check
  CHECK (hardware_type IN ('printer', 'cash_drawer', 'scale', 'customer_display', 'barcode_scanner', 'payment_terminal'));
