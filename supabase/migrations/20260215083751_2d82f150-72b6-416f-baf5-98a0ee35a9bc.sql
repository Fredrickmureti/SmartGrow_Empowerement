ALTER TABLE public.permission_groups
ADD COLUMN IF NOT EXISTS is_additive BOOLEAN DEFAULT false;