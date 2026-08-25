ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS allows_cross_branch_work boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS time_entry_open_to_org boolean NOT NULL DEFAULT false;