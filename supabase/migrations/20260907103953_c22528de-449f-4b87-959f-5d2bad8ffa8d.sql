DROP TABLE IF EXISTS public.organization_payment_gateways CASCADE;

DROP TYPE IF EXISTS public.pos_terminal_provider CASCADE;

ALTER TYPE public.payment_method_type RENAME TO payment_method_type_old;

CREATE TYPE public.payment_method_type AS ENUM ('bank', 'mobile_money', 'cash');

ALTER TABLE public.organization_payment_methods
  ALTER COLUMN type TYPE public.payment_method_type
  USING (type::text::public.payment_method_type);

DROP TYPE public.payment_method_type_old;