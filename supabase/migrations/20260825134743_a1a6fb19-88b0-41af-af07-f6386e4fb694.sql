ALTER TABLE public.project_members
  ADD COLUMN IF NOT EXISTS project_role text NOT NULL DEFAULT 'member',
  ADD COLUMN IF NOT EXISTS can_write boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_billable_participant boolean NOT NULL DEFAULT true;

UPDATE public.project_members
   SET project_role = CASE
         WHEN lower(coalesce(role,'')) IN ('manager','project_manager','owner') THEN 'manager'
         WHEN lower(coalesce(role,'')) IN ('lead','team_lead') THEN 'lead'
         ELSE 'member'
       END,
       can_write = lower(coalesce(role,'')) IN ('manager','project_manager','owner','lead','team_lead');

ALTER TABLE public.project_members
  ADD CONSTRAINT project_members_project_role_chk
  CHECK (project_role IN ('manager','lead','member'));