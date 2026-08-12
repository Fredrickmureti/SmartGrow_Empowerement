DROP FUNCTION IF EXISTS public.create_vendor_credit_note_atomic(uuid, uuid, uuid, uuid, uuid, date, text, jsonb, boolean, text);
DROP FUNCTION IF EXISTS public.update_vendor_credit_note_atomic(uuid, uuid, uuid, date, text, jsonb);
NOTIFY pgrst, 'reload schema';