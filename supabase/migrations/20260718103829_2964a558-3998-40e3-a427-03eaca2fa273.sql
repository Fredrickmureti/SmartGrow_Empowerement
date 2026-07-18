
ALTER TYPE public.po_status ADD VALUE IF NOT EXISTS 'submitted';
ALTER TYPE public.po_status ADD VALUE IF NOT EXISTS 'approved';
ALTER TYPE public.po_status ADD VALUE IF NOT EXISTS 'acknowledged';
ALTER TYPE public.po_status ADD VALUE IF NOT EXISTS 'closed';
ALTER TYPE public.po_status ADD VALUE IF NOT EXISTS 'revised';
ALTER TYPE public.po_status ADD VALUE IF NOT EXISTS 'rejected';
