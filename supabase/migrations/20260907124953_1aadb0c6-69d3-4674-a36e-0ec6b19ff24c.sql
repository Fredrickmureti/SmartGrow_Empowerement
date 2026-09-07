CREATE OR REPLACE FUNCTION public.reset_module__sales(org_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Sales-order / delivery-note / sales-return documents were retired with the
  -- ERP commercial stack. Nothing left to reset; kept for dispatcher stability.
  RETURN jsonb_build_object('deleted', 0, 'retired', true);
END;
$$;

DROP TABLE IF EXISTS public.delivery_note_events CASCADE;
DROP TABLE IF EXISTS public.delivery_note_items CASCADE;
DROP TABLE IF EXISTS public.delivery_notes CASCADE;
DROP TABLE IF EXISTS public.sales_return_cost_basis CASCADE;
DROP TABLE IF EXISTS public.sales_return_items CASCADE;
DROP TABLE IF EXISTS public.sales_returns CASCADE;
DROP TABLE IF EXISTS public.sales_order_items CASCADE;
DROP TABLE IF EXISTS public.sales_orders CASCADE;
DROP TABLE IF EXISTS public.sales_document_idempotency CASCADE;

DROP FUNCTION IF EXISTS public._confirm_invoice_core(uuid,uuid,jsonb,text);
DROP FUNCTION IF EXISTS public.confirm_invoice_and_release_stock_atomic(uuid,uuid,jsonb,boolean,uuid,text);
DROP FUNCTION IF EXISTS public._log_dn_event(uuid,text,uuid,text,jsonb);
DROP FUNCTION IF EXISTS public._recalc_document_totals();
DROP FUNCTION IF EXISTS public._totals_normalize_line();
DROP FUNCTION IF EXISTS public._sales_doc_is_mutable(text,text);
DROP FUNCTION IF EXISTS public._sales_header_totals_guard();
DROP FUNCTION IF EXISTS public._stamp_sales_return_wms_origin();
DROP FUNCTION IF EXISTS public._tg_stamp_sales_order_currency();
DROP FUNCTION IF EXISTS public._wms_client_from_wave(uuid,uuid);
DROP FUNCTION IF EXISTS public._wms_consume_order_reservation(uuid,uuid,numeric);
DROP FUNCTION IF EXISTS public._wms_manifest_after_dispatch(uuid);
DROP FUNCTION IF EXISTS public.confirm_sales_order_atomic(uuid,uuid);
DROP FUNCTION IF EXISTS public.convert_estimate_to_so_atomic(uuid,uuid);
DROP FUNCTION IF EXISTS public.convert_so_to_invoice_atomic(uuid,uuid);
DROP FUNCTION IF EXISTS public.create_delivery_from_sales_order_atomic(uuid,uuid,jsonb,date);
DROP FUNCTION IF EXISTS public.create_delivery_note_atomic(jsonb,jsonb,uuid);
DROP FUNCTION IF EXISTS public.create_invoice_from_delivery_atomic(uuid,uuid);
DROP FUNCTION IF EXISTS public.create_return_delivery_atomic(uuid,uuid,jsonb,text,boolean);
DROP FUNCTION IF EXISTS public.create_sales_return_atomic(jsonb);
DROP FUNCTION IF EXISTS public.dispatch_delivery_atomic(uuid,uuid,jsonb);
DROP FUNCTION IF EXISTS public.enforce_delivery_note_contact_business_match();
DROP FUNCTION IF EXISTS public.enforce_downstream_lot_stamping();
DROP FUNCTION IF EXISTS public.enforce_invoice_so_business_match();
DROP FUNCTION IF EXISTS public.enforce_sales_order_items_lock();
DROP FUNCTION IF EXISTS public.enforce_sales_return_qty_ledger();
DROP FUNCTION IF EXISTS public.get_next_delivery_number(uuid,uuid);
DROP FUNCTION IF EXISTS public.get_next_sales_return_number(uuid,uuid,uuid);
DROP FUNCTION IF EXISTS public.get_next_so_number(uuid,uuid,uuid);
DROP FUNCTION IF EXISTS public.get_sales_dashboard_kpis(uuid,uuid,date,date,uuid);
DROP FUNCTION IF EXISTS public.lock_sales_order_on_dn_invoice();
DROP FUNCTION IF EXISTS public.mark_delivery_ready_atomic(uuid,uuid);
DROP FUNCTION IF EXISTS public.record_partial_delivery_atomic(uuid,uuid,jsonb,boolean,text,jsonb,uuid);
DROP FUNCTION IF EXISTS public.release_sales_order_reservations_atomic(uuid);
DROP FUNCTION IF EXISTS public.set_sales_order_approval_state_atomic(uuid,text,uuid,text);
DROP FUNCTION IF EXISTS public.transition_sales_return(uuid,text,text);
DROP FUNCTION IF EXISTS public.trg_so_lines_repost_revenue();
DROP FUNCTION IF EXISTS public.update_delivery_logistics_atomic(uuid,uuid,jsonb);
DROP FUNCTION IF EXISTS public.update_sales_order_atomic(uuid,jsonb,jsonb,uuid);
DROP FUNCTION IF EXISTS public.wms_manifest_delivery_notes(uuid);
DROP FUNCTION IF EXISTS public.wms_wave_demand(uuid,uuid);