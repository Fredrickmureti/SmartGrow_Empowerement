DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.relname, c.relkind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r','v')
      AND c.relname ~ '^(v_)?(products?|product_|inventory|stock|warehouse|wms|bin_|lot_|lots|serial|uom|packaging|barcode|price_list|pricelist|putaway|picking|pick_|cycle_count|handling_unit|landed_cost|goods_receipt|inbound_shipment|purchase|supplier|approved_supplier|rfq|requisition|procurement|crm_|projects?_|project_|task_|timesheet)'
    LOOP
      IF r.relkind = 'r' THEN
        EXECUTE format('DROP TABLE IF EXISTS public.%I CASCADE', r.relname);
      ELSE
        EXECUTE format('DROP VIEW IF EXISTS public.%I CASCADE', r.relname);
      END IF;
    END LOOP;
END $$;