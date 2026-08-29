ALTER TABLE public.user_pins DROP CONSTRAINT IF EXISTS user_pins_user_id_device_fingerprint_key;

DELETE FROM public.user_pins a
USING public.user_pins b
WHERE a.user_id = b.user_id AND a.ctid < b.ctid;

ALTER TABLE public.user_pins ADD CONSTRAINT user_pins_user_id_key UNIQUE (user_id);