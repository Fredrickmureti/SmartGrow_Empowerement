-- Phase 1a — wave lifecycle vocabulary. Enum values must be added in their
-- own transaction before any function can reference them.
ALTER TYPE public.wms_wave_state ADD VALUE IF NOT EXISTS 'planned' AFTER 'draft';
ALTER TYPE public.wms_wave_state ADD VALUE IF NOT EXISTS 'ready' AFTER 'planned';
ALTER TYPE public.wms_wave_state ADD VALUE IF NOT EXISTS 'suspended' AFTER 'packing';
ALTER TYPE public.wms_wave_state ADD VALUE IF NOT EXISTS 'completed' AFTER 'packed';
ALTER TYPE public.wms_wave_state ADD VALUE IF NOT EXISTS 'archived' AFTER 'completed';