-- 1) Give the API role headroom: the invoice confirm path (GL posting +
--    auto delivery note + lot consumption + cost layers) legitimately runs
--    2-5s and was being killed by the default 8s statement timeout under
--    concurrent background polling. 30s is still bounded.
ALTER ROLE authenticated SET statement_timeout = '30s';
ALTER ROLE anon SET statement_timeout = '10s';

-- 2) Fresh planner statistics for the hot sales/inventory/GL tables. Several
--    of these had never been analyzed, so every PostgREST query was planned
--    against default estimates.
ANALYZE public.invoices;
ANALYZE public.invoice_items;
ANALYZE public.delivery_notes;
ANALYZE public.delivery_note_items;
ANALYZE public.stock_movements;
ANALYZE public.stock_quants;
ANALYZE public.warehouse_stock_lots;
ANALYZE public.stock_lots;
ANALYZE public.cost_layers;
ANALYZE public.journal_entries;
ANALYZE public.journal_entry_lines;
ANALYZE public.accounts;
ANALYZE public.fiscal_periods;
ANALYZE public.products;
ANALYZE public.business_event_outbox;