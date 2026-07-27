DROP FUNCTION IF EXISTS public.resolve_device_for_workflow(uuid, text, uuid, uuid) CASCADE;
DROP FUNCTION IF EXISTS public.resolve_workflow_printer(uuid, text, uuid, uuid) CASCADE;
DROP TABLE IF EXISTS public.workstation_devices CASCADE;