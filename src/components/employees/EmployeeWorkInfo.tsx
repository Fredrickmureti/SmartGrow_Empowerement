import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmployeeProfile } from "@/hooks/useEmployeeProfile";
import { format } from "date-fns";
import { EmployeeBranchAssignmentsCard } from "@/components/employees/EmployeeBranchAssignmentsCard";
import { usePermissions } from "@/hooks/usePermissions";

interface Props {
  employee: EmployeeProfile;
}

function InfoRow({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center gap-1 py-2 border-b border-border/50 last:border-0">
      <span className="text-sm text-muted-foreground w-40 shrink-0">{label}</span>
      <span className="text-sm font-medium">{value || "—"}</span>
    </div>
  );
}

export function EmployeeWorkInfo({ employee }: Props) {
  const { can } = usePermissions();
  const canManage = can("manageEmployees");
  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Position</CardTitle>
          </CardHeader>
          <CardContent className="space-y-0">
            <InfoRow label="Job Title" value={employee.position} />
            <InfoRow label="Department" value={employee.department_name} />
            <InfoRow label="Manager" value={employee.manager ? `${employee.manager.first_name} ${employee.manager.last_name}` : null} />
            {employee.managed_departments && employee.managed_departments.length > 0 && (
              <InfoRow label="Manages" value={employee.managed_departments.join(", ")} />
            )}
            <InfoRow label="Employment Type" value={employee.employment_type?.replace("_", " ")} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Dates</CardTitle>
          </CardHeader>
          <CardContent className="space-y-0">
            <InfoRow label="Hire Date" value={employee.hire_date ? format(new Date(employee.hire_date), "MMM d, yyyy") : null} />
            <InfoRow label="Termination Date" value={employee.termination_date ? format(new Date(employee.termination_date), "MMM d, yyyy") : null} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Contact</CardTitle>
          </CardHeader>
          <CardContent className="space-y-0">
            <InfoRow label="Work Email" value={employee.work_email} />
            <InfoRow label="Email" value={employee.email} />
            <InfoRow label="Phone" value={employee.phone} />
          </CardContent>
        </Card>
      </div>

      <EmployeeBranchAssignmentsCard employeeId={employee.id} canEdit={canManage} />
    </div>
  );
}
