CREATE OR REPLACE FUNCTION public.reset_module__pos(org_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v jsonb := '{}'::jsonb; n bigint;
BEGIN
  IF to_regclass('public.pos_split_bill_items') IS NOT NULL THEN
    WITH d AS (
      DELETE FROM pos_split_bill_items
       WHERE portion_id IN (
         SELECT p.id FROM pos_split_bill_portions p
         JOIN pos_split_bills b ON b.id = p.split_bill_id
         WHERE b.organization_id = org_id
       )
       RETURNING 1
    ) SELECT count(*) INTO n FROM d;
    v := v || jsonb_build_object('pos_split_bill_items', n);
  END IF;

  IF to_regclass('public.pos_split_bill_portions') IS NOT NULL THEN
    WITH d AS (
      DELETE FROM pos_split_bill_portions
       WHERE split_bill_id IN (SELECT id FROM pos_split_bills WHERE organization_id = org_id)
       RETURNING 1
    ) SELECT count(*) INTO n FROM d;
    v := v || jsonb_build_object('pos_split_bill_portions', n);
  END IF;

  IF to_regclass('public.pos_split_bills') IS NOT NULL THEN
    WITH d AS (DELETE FROM pos_split_bills WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
    v := v || jsonb_build_object('pos_split_bills', n);
  END IF;

  IF to_regclass('public.pos_kitchen_tickets') IS NOT NULL THEN
    EXECUTE format('WITH d AS (DELETE FROM pos_kitchen_tickets WHERE organization_id=%L RETURNING 1) SELECT count(*) FROM d', org_id) INTO n;
    v := v || jsonb_build_object('pos_kitchen_tickets', n);
  END IF;

  IF to_regclass('public.pos_kitchen_orders') IS NOT NULL THEN
    EXECUTE format('WITH d AS (DELETE FROM pos_kitchen_orders WHERE organization_id=%L RETURNING 1) SELECT count(*) FROM d', org_id) INTO n;
    v := v || jsonb_build_object('pos_kitchen_orders', n);
  END IF;

  IF to_regclass('public.pos_table_sessions') IS NOT NULL THEN
    WITH d AS (DELETE FROM pos_table_sessions WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
    v := v || jsonb_build_object('pos_table_sessions', n);
  END IF;

  IF to_regclass('public.pos_gift_card_transactions') IS NOT NULL THEN
    EXECUTE format('WITH d AS (DELETE FROM pos_gift_card_transactions WHERE organization_id=%L RETURNING 1) SELECT count(*) FROM d', org_id) INTO n;
    v := v || jsonb_build_object('pos_gift_card_transactions', n);
  END IF;

  IF to_regclass('public.pos_held_transactions') IS NOT NULL THEN
    EXECUTE format('WITH d AS (DELETE FROM pos_held_transactions WHERE organization_id=%L RETURNING 1) SELECT count(*) FROM d', org_id) INTO n;
    v := v || jsonb_build_object('pos_held_transactions', n);
  END IF;

  IF to_regclass('public.pos_transaction_items') IS NOT NULL THEN
    WITH d AS (DELETE FROM pos_transaction_items WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
    v := v || jsonb_build_object('pos_transaction_items', n);
  END IF;

  IF to_regclass('public.pos_transactions') IS NOT NULL THEN
    WITH d AS (DELETE FROM pos_transactions WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
    v := v || jsonb_build_object('pos_transactions', n);
  END IF;

  IF to_regclass('public.pos_shifts') IS NOT NULL THEN
    WITH d AS (DELETE FROM pos_shifts WHERE organization_id=org_id RETURNING 1) SELECT count(*) INTO n FROM d;
    v := v || jsonb_build_object('pos_shifts', n);
  END IF;

  IF to_regclass('public.cashier_registers') IS NOT NULL THEN
    EXECUTE format('WITH d AS (DELETE FROM cashier_registers WHERE organization_id=%L RETURNING 1) SELECT count(*) FROM d', org_id) INTO n;
    v := v || jsonb_build_object('cashier_registers', n);
  END IF;

  RETURN v;
END; $$;