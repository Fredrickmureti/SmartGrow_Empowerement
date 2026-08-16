-- The transfer engines park dispatched stock at a virtual transit location.
-- That location was created with warehouse_id = NULL, but warehouse balances
-- are projected from quants through stock_locations.warehouse_id
-- (_project_warehouse_stock_from_quants, ADR 0142). A warehouse-less transit
-- location therefore projected onto no warehouse: the in-transit warehouse
-- always read zero on hand and complete_stock_transfer_atomic failed with
-- "Insufficient stock in warehouse. Available: 0" for every transfer.
--
-- One representation of "in transit": the transit location belongs to the
-- business's in-transit warehouse.

CREATE OR REPLACE FUNCTION public.get_business_transit_location(p_business_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_loc uuid;
  v_wh  uuid;
  v_org uuid;
BEGIN
  v_wh := public.get_or_create_in_transit_warehouse(p_business_id);

  SELECT id INTO v_loc
    FROM public.stock_locations
   WHERE business_id = p_business_id
     AND warehouse_id = v_wh
     AND location_type = 'transit'
   LIMIT 1;

  IF v_loc IS NOT NULL THEN
    RETURN v_loc;
  END IF;

  -- Adopt a legacy warehouse-less transit location instead of minting a rival.
  SELECT id INTO v_loc
    FROM public.stock_locations
   WHERE business_id = p_business_id
     AND location_type = 'transit'
     AND warehouse_id IS NULL
   LIMIT 1;

  IF v_loc IS NOT NULL THEN
    UPDATE public.stock_locations SET warehouse_id = v_wh, updated_at = now()
     WHERE id = v_loc;
    RETURN v_loc;
  END IF;

  SELECT organization_id INTO v_org FROM public.businesses WHERE id = p_business_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Business % not found', p_business_id;
  END IF;

  INSERT INTO public.stock_locations (
    organization_id, business_id, warehouse_id, code, name,
    location_type, usage, is_active, is_default
  ) VALUES (
    v_org, p_business_id, v_wh, 'TRANSIT', 'In Transit',
    'transit'::stock_location_type, 'virtual'::stock_location_usage, true, false
  )
  ON CONFLICT (warehouse_id, code) DO UPDATE SET is_active = true
  RETURNING id INTO v_loc;

  RETURN v_loc;
END;
$function$;

-- Re-scope existing transit locations onto their in-transit warehouse.
UPDATE public.stock_locations l
   SET warehouse_id = public.get_or_create_in_transit_warehouse(l.business_id),
       updated_at = now()
 WHERE l.location_type = 'transit'
   AND l.warehouse_id IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM public.stock_locations x
      WHERE x.business_id = l.business_id
        AND x.location_type = 'transit'
        AND x.warehouse_id IS NOT NULL
   );