import { Navigate } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { useCurrentEmployee } from "@/hooks/useCurrentEmployee";
import { EmployeeLinkRequired } from "@/components/me/EmployeeLinkRequired";

/**
 * My Profile - redirects the current user to their own employee profile.
 * Accessible to ALL internal users (cashiers, staff, etc.).
 *
 * When no employee record exists, the uniform EmployeeLinkRequired empty
 * state is rendered (which itself decides whether to show a self-link CTA
 * based on the server-side resolve_my_employee verdict).
 */
export default function MyProfile() {
  const { currentEmployee, isLoading } = useCurrentEmployee();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (currentEmployee?.id) {
    return <Navigate to={`/hr/employees/${currentEmployee.id}`} replace />;
  }

  return <EmployeeLinkRequired />;
}
