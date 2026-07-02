import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ArrowLeft, MoreVertical, Shield } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { EmployeeAvatarUpload } from "./EmployeeAvatarUpload";
import { EmployeeProfile } from "@/hooks/useEmployeeProfile";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface EmployeeProfileHeaderProps {
  employee: EmployeeProfile;
  canEdit: boolean;
  onAvatarChange: (url: string) => void;
  /**
   * When provided, an overflow menu appears beside the header with an
   * "HR Settings" entry. HR Settings is configuration, not an information
   * pane — it moved off the sidebar in Wave G to reduce IA noise.
   */
  onOpenHrSettings?: () => void;
}

const ACCESS_STATUS_STYLES: Record<string, string> = {
  none: "bg-muted text-muted-foreground",
  invited: "bg-warning/10 text-warning border-warning/20",
  portal: "bg-accent/10 text-accent border-accent/20",
  internal: "bg-primary/10 text-primary border-primary/20",
};

const ACCESS_STATUS_LABELS: Record<string, string> = {
  none: "No Access",
  invited: "Invited",
  portal: "Portal User",
  internal: "Internal User",
};

export function EmployeeProfileHeader({
  employee,
  canEdit,
  onAvatarChange,
  onOpenHrSettings,
}: EmployeeProfileHeaderProps) {
  const navigate = useNavigate();

  return (
    <div className="space-y-4">
      <Button variant="ghost" size="sm" onClick={() => navigate(-1)} className="gap-2">
        <ArrowLeft className="h-4 w-4" />
        Back
      </Button>

      <div className="flex flex-col sm:flex-row items-start gap-4 sm:gap-6">
        <EmployeeAvatarUpload
          employeeId={employee.id}
          organizationId={employee.organization_id}
          currentAvatarUrl={employee.avatar_url}
          firstName={employee.first_name}
          lastName={employee.last_name}
          canEdit={canEdit}
          onAvatarChange={onAvatarChange}
        />

        <div className="flex-1 min-w-0 space-y-1">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-2xl font-bold tracking-tight">
              {employee.first_name} {employee.last_name}
            </h1>
            <Badge
              className={employee.is_active
                ? "bg-success/10 text-success border-success/20"
                : "bg-destructive/10 text-destructive border-destructive/20"
              }
              variant="outline"
            >
              {employee.is_active ? "Active" : "Inactive"}
            </Badge>
            <Badge
              variant="outline"
              className={ACCESS_STATUS_STYLES[employee.user_access_status] || ACCESS_STATUS_STYLES.none}
            >
              {ACCESS_STATUS_LABELS[employee.user_access_status] || "No Access"}
            </Badge>
          </div>
          <p className="text-muted-foreground">
            {employee.position || "No position"} • {employee.department_name || "No department"}
          </p>
          <p className="text-sm text-muted-foreground font-mono">{employee.employee_number}</p>
        </div>

        {onOpenHrSettings && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="More actions">
                <MoreVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={onOpenHrSettings}>
                <Shield className="h-4 w-4 mr-2" />
                HR Settings
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </div>
  );
}
