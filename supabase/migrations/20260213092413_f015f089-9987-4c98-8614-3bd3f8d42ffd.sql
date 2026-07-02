
-- Update the check constraint to include 'pos_sale' as a valid movement type
ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_movement_type_check;
ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_movement_type_check 
  CHECK (movement_type = ANY (ARRAY['purchase','sale','pos_sale','adjustment','return_in','return_out','transfer','opening']));
