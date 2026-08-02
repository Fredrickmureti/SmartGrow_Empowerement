REVOKE ALL ON FUNCTION public.wms_next_lpn_code(_business_id uuid, _warehouse_id uuid, _lpn_type wms_lpn_type) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_next_lpn_code(_business_id uuid, _warehouse_id uuid, _lpn_type wms_lpn_type) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.wms_lpn_tree(_lpn_id uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_lpn_tree(_lpn_id uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.wms_lpn_move(_lpn_id uuid, _to_location_id uuid, _expected_version integer, _reason text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_lpn_move(_lpn_id uuid, _to_location_id uuid, _expected_version integer, _reason text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.wms_lpn_load(_lpn_id uuid, _product_id uuid, _quantity numeric, _lot_number text, _serial_number text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_lpn_load(_lpn_id uuid, _product_id uuid, _quantity numeric, _lot_number text, _serial_number text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.wms_lpn_unload(_lpn_id uuid, _product_id uuid, _quantity numeric, _lot_number text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_lpn_unload(_lpn_id uuid, _product_id uuid, _quantity numeric, _lot_number text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.wms_lpn_split(_lpn_id uuid, _lines jsonb, _new_lpn_type wms_lpn_type) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_lpn_split(_lpn_id uuid, _lines jsonb, _new_lpn_type wms_lpn_type) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.wms_lpn_merge(_source_lpn_ids uuid[], _target_lpn_id uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_lpn_merge(_source_lpn_ids uuid[], _target_lpn_id uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.wms_lpn_nest(_child_lpn_id uuid, _parent_lpn_id uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_lpn_nest(_child_lpn_id uuid, _parent_lpn_id uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.wms_lpn_unnest(_child_lpn_id uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_lpn_unnest(_child_lpn_id uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.wms_packaging_consume(p_business_id uuid, p_warehouse_id uuid, p_packaging_type_id uuid, p_qty numeric, p_reference_type text, p_reference_id uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wms_packaging_consume(p_business_id uuid, p_warehouse_id uuid, p_packaging_type_id uuid, p_qty numeric, p_reference_type text, p_reference_id uuid) TO authenticated, service_role;