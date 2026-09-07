DROP FUNCTION IF EXISTS public.request_reprint(uuid, text, text) CASCADE;
DROP FUNCTION IF EXISTS public.request_reprint(uuid, text) CASCADE;

DROP TABLE IF EXISTS public.reprint_requests CASCADE;
DROP TABLE IF EXISTS public.transaction_lines CASCADE;
DROP TABLE IF EXISTS public.transactions CASCADE;