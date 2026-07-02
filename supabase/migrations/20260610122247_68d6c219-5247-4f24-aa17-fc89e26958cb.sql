DROP TRIGGER IF EXISTS notify_overtime_decision ON public.overtime_requests;

DROP FUNCTION IF EXISTS public.trg_notify_overtime_decision();