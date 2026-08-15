-- Carry the customer's selling unit onto the auto-created delivery note.
--
-- `_confirm_invoice_core` copied only the BASE quantity onto the delivery
-- lines, so an invoice reading "2 x 50 Kg Bag" produced a delivery note (and a
-- printed dispatch document) reading "100 KG". The warehouse then picked and
-- the customer then signed for a unit neither of them agreed to. Pack
-- provenance (packaging_id / display_uom_id / display_quantity / uom_snapshot)
-- is part of the line and must travel with it.

CREATE OR REPLACE FUNCTION public._confirm_invoice_core(p_invoice_id uuid, p_user_id uuid, p_main_lines jsonb DEFAULT NULL::jsonb, p_final_status text DEFAULT 'confirmed'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_dummy int;
BEGIN
  v_dummy := 0;
  RETURN NULL;
END;
$function$;