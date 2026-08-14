-- ============================================================
-- ADR 0142 Phase 3 item 1 — reversal parity registry
-- ============================================================

CREATE TABLE IF NOT EXISTS public.stock_movement_writers (
  function_name     text PRIMARY KEY,
  writer_kind       text NOT NULL CHECK (writer_kind IN ('forward', 'reversal', 'selftest')),
  reversal_function text,
  notes             text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stock_movement_writers_forward_needs_reversal
    CHECK (writer_kind <> 'forward' OR reversal_function IS NOT NULL)
);

GRANT SELECT ON public.stock_movement_writers TO authenticated;
GRANT ALL    ON public.stock_movement_writers TO service_role;

ALTER TABLE public.stock_movement_writers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "movement writers readable by authenticated users"
  ON public.stock_movement_writers;
CREATE POLICY "movement writers readable by authenticated users"
  ON public.stock_movement_writers FOR SELECT TO authenticated USING (true);

DROP TRIGGER IF EXISTS trg_stock_movement_writers_updated_at ON public.stock_movement_writers;
CREATE TRIGGER trg_stock_movement_writers_updated_at
  BEFORE UPDATE ON public.stock_movement_writers
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

INSERT INTO public.stock_movement_writers (function_name, writer_kind, reversal_function, notes) VALUES
  ('_emit_quarantine_movements',    'forward',  'reverse_stock_movement',        'Quarantine hold/release trigger helper; generic compensating reversal'),
  ('_pos_write_stock_movement',     'forward',  'process_pos_void',              'POS sale line; voided through the POS void workflow'),
  ('_wms_qc_post_move',             'forward',  'reverse_stock_movement',        'QC disposition move; generic compensating reversal'),
  ('approve_sales_return_atomic',   'forward',  'reverse_stock_movement',        'Sales return intake; generic compensating reversal'),
  ('approve_stock_adjustment_atomic','forward', 'reverse_stock_adjustment_atomic','Adjustment posting has a dedicated reversal RPC'),
  ('approve_stock_transfer_atomic', 'forward',  'cancel_stock_transfer_atomic',  'Transfer issue; cancellation unwinds both legs'),
  ('complete_delivery_atomic',      'forward',  'cancel_delivery_atomic',        'Delivery outbound; cancellation restores stock'),
  ('complete_replenish_task',       'forward',  'reverse_stock_movement',        'WMS replenishment move; generic compensating reversal'),
  ('complete_stock_transfer_atomic','forward',  'cancel_stock_transfer_atomic',  'Transfer receipt; cancellation unwinds both legs'),
  ('consume_lots_atomic',           'forward',  'reverse_stock_movement',        'FEFO/lot consumption primitive; caller reversal or generic reversal'),
  ('purchase_return_dispatch',      'forward',  'reverse_stock_movement',        'Return-to-vendor dispatch; generic compensating reversal'),
  ('record_opening_stock',          'forward',  'reverse_stock_movement',        'Opening balance load; generic compensating reversal'),
  ('wms_apply_gr_stock',            'forward',  'wms_reverse_gr_stock',          'Goods receipt posting has a dedicated reversal RPC'),
  ('wms_lpn_dispatch',              'forward',  'reverse_stock_movement',        'LPN dispatch; generic compensating reversal'),
  ('wms_lpn_move',                  'forward',  'reverse_stock_movement',        'LPN relocation; generic compensating reversal'),
  ('wms_lpn_receive_return',        'forward',  'reverse_stock_movement',        'LPN return intake; generic compensating reversal'),
  ('wms_post_receiving_session',    'forward',  'reverse_stock_movement',        'Receiving session posting; generic compensating reversal'),
  ('wms_post_return_dispositions',  'forward',  'reverse_stock_movement',        'Return dispositions posting; generic compensating reversal'),
  ('cancel_delivery_atomic',        'reversal', NULL, 'Reversal path for complete_delivery_atomic'),
  ('cancel_stock_transfer_atomic',  'reversal', NULL, 'Reversal path for the transfer RPCs'),
  ('physical_count_supersede',      'reversal', NULL, 'Reverses a superseded physical count posting'),
  ('restore_invoice_stock_atomic',  'reversal', NULL, 'Reversal path for invoice confirmation stock'),
  ('reverse_stock_movement',        'reversal', NULL, 'Canonical generic compensating-reversal primitive'),
  ('wms_reverse_gr_stock',          'reversal', NULL, 'Reversal path for wms_apply_gr_stock'),
  ('landed_cost_selftest',          'selftest', NULL, 'Internal self-test harness; rolls back its own fixtures')
ON CONFLICT (function_name) DO UPDATE
  SET writer_kind = EXCLUDED.writer_kind,
      reversal_function = EXCLUDED.reversal_function,
      notes = EXCLUDED.notes;

-- Coverage check: unregistered writers, and registered reversals that vanished
CREATE OR REPLACE FUNCTION public.check_movement_reversal_coverage()
RETURNS TABLE(issue text, function_name text, detail text)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH writers AS (
    SELECT DISTINCT p.proname AS fn
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND pg_get_functiondef(p.oid) ~* 'INSERT INTO (public\.)?stock_movements'
  )
  SELECT 'unregistered_writer'::text, w.fn,
         'writes stock_movements but is absent from stock_movement_writers'::text
    FROM writers w
    LEFT JOIN public.stock_movement_writers r ON r.function_name = w.fn
   WHERE r.function_name IS NULL

  UNION ALL
  SELECT 'stale_registration'::text, r.function_name,
         'registered writer no longer writes stock_movements'::text
    FROM public.stock_movement_writers r
    LEFT JOIN writers w ON w.fn = r.function_name
   WHERE w.fn IS NULL

  UNION ALL
  SELECT 'missing_reversal'::text, r.function_name,
         'reversal function ' || r.reversal_function || ' does not exist'::text
    FROM public.stock_movement_writers r
   WHERE r.reversal_function IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = r.reversal_function
     )
$function$;

GRANT EXECUTE ON FUNCTION public.check_movement_reversal_coverage() TO authenticated;
GRANT EXECUTE ON FUNCTION public.check_movement_reversal_coverage() TO service_role;