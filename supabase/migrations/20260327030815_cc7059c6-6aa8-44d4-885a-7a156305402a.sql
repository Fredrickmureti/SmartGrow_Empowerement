
-- Add work_schedule_id to employees
ALTER TABLE public.employees ADD COLUMN IF NOT EXISTS work_schedule_id UUID REFERENCES public.work_schedules(id);

-- Create work_schedule_days for detailed per-day scheduling
CREATE TABLE public.work_schedule_days (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  schedule_id UUID NOT NULL REFERENCES public.work_schedules(id) ON DELETE CASCADE,
  day_of_week TEXT NOT NULL,
  is_work_day BOOLEAN NOT NULL DEFAULT true,
  start_time TIME,
  end_time TIME,
  break_minutes INTEGER NOT NULL DEFAULT 60,
  UNIQUE(schedule_id, day_of_week)
);

ALTER TABLE public.work_schedule_days ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view work schedule days"
  ON public.work_schedule_days FOR SELECT TO authenticated
  USING (schedule_id IN (
    SELECT ws.id FROM public.work_schedules ws
    WHERE EXISTS (
      SELECT 1 FROM public.user_roles ur 
      WHERE ur.user_id = auth.uid() AND ur.organization_id = ws.organization_id
    )
  ));

CREATE POLICY "Admins can manage work schedule days"
  ON public.work_schedule_days FOR ALL TO authenticated
  USING (schedule_id IN (
    SELECT ws.id FROM public.work_schedules ws
    WHERE EXISTS (
      SELECT 1 FROM public.user_roles ur 
      WHERE ur.user_id = auth.uid() 
        AND ur.organization_id = ws.organization_id
        AND ur.role IN ('super_admin', 'owner', 'admin')
    )
  ))
  WITH CHECK (schedule_id IN (
    SELECT ws.id FROM public.work_schedules ws
    WHERE EXISTS (
      SELECT 1 FROM public.user_roles ur 
      WHERE ur.user_id = auth.uid() 
        AND ur.organization_id = ws.organization_id
        AND ur.role IN ('super_admin', 'owner', 'admin')
    )
  ));
