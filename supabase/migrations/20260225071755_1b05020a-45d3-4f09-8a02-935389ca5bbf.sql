
-- ─── Attendance Module Schema ───

-- Attendance records: clock-in/out per employee per day
CREATE TABLE IF NOT EXISTS public.attendance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id uuid REFERENCES public.businesses(id) ON DELETE SET NULL,
  employee_id uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  attendance_date date NOT NULL DEFAULT CURRENT_DATE,
  clock_in timestamptz,
  clock_out timestamptz,
  worked_hours numeric(5,2) DEFAULT 0,
  overtime_hours numeric(5,2) DEFAULT 0,
  break_duration_minutes integer DEFAULT 0,
  status text NOT NULL DEFAULT 'present' CHECK (status IN ('present', 'absent', 'late', 'half_day', 'on_leave', 'holiday')),
  notes text,
  clock_in_method text DEFAULT 'manual' CHECK (clock_in_method IN ('manual', 'biometric', 'geofence', 'qr_code')),
  clock_in_location jsonb,
  clock_out_location jsonb,
  approved_by uuid REFERENCES auth.users(id),
  approved_at timestamptz,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id, employee_id, attendance_date)
);

-- Enable RLS
ALTER TABLE public.attendance ENABLE ROW LEVEL SECURITY;

-- RLS policies for attendance
CREATE POLICY "Users can view own attendance"
  ON public.attendance FOR SELECT
  TO authenticated
  USING (
    employee_id IN (
      SELECT id FROM public.employees WHERE user_id = auth.uid()
    )
    OR
    EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid()
        AND organization_id = attendance.organization_id
        AND role IN ('super_admin', 'owner', 'admin', 'accountant', 'staff')
    )
  );

CREATE POLICY "Staff can insert attendance"
  ON public.attendance FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid()
        AND organization_id = attendance.organization_id
    )
  );

CREATE POLICY "Admin can update attendance"
  ON public.attendance FOR UPDATE
  TO authenticated
  USING (
    employee_id IN (
      SELECT id FROM public.employees WHERE user_id = auth.uid()
    )
    OR
    EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid()
        AND organization_id = attendance.organization_id
        AND role IN ('super_admin', 'owner', 'admin')
    )
  );

CREATE POLICY "Admin can delete attendance"
  ON public.attendance FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid()
        AND organization_id = attendance.organization_id
        AND role IN ('super_admin', 'owner', 'admin')
    )
  );

-- Work schedules (defines standard hours per day/week)
CREATE TABLE IF NOT EXISTS public.work_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  is_default boolean DEFAULT false,
  standard_hours_per_day numeric(4,2) DEFAULT 8,
  standard_hours_per_week numeric(5,2) DEFAULT 40,
  work_days jsonb DEFAULT '["monday","tuesday","wednesday","thursday","friday"]'::jsonb,
  overtime_multiplier numeric(3,2) DEFAULT 1.5,
  is_active boolean DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.work_schedules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Org members can view work schedules"
  ON public.work_schedules FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid()
        AND organization_id = work_schedules.organization_id
    )
  );

CREATE POLICY "Admin can manage work schedules"
  ON public.work_schedules FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid()
        AND organization_id = work_schedules.organization_id
        AND role IN ('super_admin', 'owner', 'admin')
    )
  );

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_attendance_org_date ON public.attendance(organization_id, attendance_date);
CREATE INDEX IF NOT EXISTS idx_attendance_employee ON public.attendance(employee_id, attendance_date);
CREATE INDEX IF NOT EXISTS idx_attendance_business ON public.attendance(business_id, attendance_date);

-- Auto-calculate worked_hours trigger
CREATE OR REPLACE FUNCTION public.calculate_worked_hours()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.clock_in IS NOT NULL AND NEW.clock_out IS NOT NULL THEN
    NEW.worked_hours := ROUND(EXTRACT(EPOCH FROM (NEW.clock_out - NEW.clock_in)) / 3600.0 - COALESCE(NEW.break_duration_minutes, 0) / 60.0, 2);
    IF NEW.worked_hours < 0 THEN
      NEW.worked_hours := 0;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_calculate_worked_hours
  BEFORE INSERT OR UPDATE ON public.attendance
  FOR EACH ROW
  EXECUTE FUNCTION public.calculate_worked_hours();
