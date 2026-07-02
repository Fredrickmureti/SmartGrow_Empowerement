-- Remove duplicate/legacy SELECT policy on attendance. The other policy
-- (attendance_select_self_or_permission) already grants the same access via
-- the 4-arg user_has_module_permission overload, scoped per business.
DROP POLICY IF EXISTS attendance_select_own_or_permitted ON public.attendance;