ALTER TABLE public.overtime_requests
  ADD CONSTRAINT overtime_requests_organization_id_fkey
    FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE,
  ADD CONSTRAINT overtime_requests_business_id_fkey
    FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE SET NULL,
  ADD CONSTRAINT overtime_requests_branch_id_fkey
    FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE SET NULL,
  ADD CONSTRAINT overtime_requests_employee_id_fkey
    FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE,
  ADD CONSTRAINT overtime_requests_requested_by_fkey
    FOREIGN KEY (requested_by) REFERENCES auth.users(id),
  ADD CONSTRAINT overtime_requests_approved_by_fkey
    FOREIGN KEY (approved_by) REFERENCES auth.users(id);

NOTIFY pgrst, 'reload schema';