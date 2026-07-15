// @ts-nocheck - organization_members not in auto-generated types
import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmployeeProfile } from "@/hooks/useEmployeeProfile";
import { EmployeeInviteDialog } from "./EmployeeInviteDialog";
import { EmployeeLinkDialog } from "./EmployeeLinkDialog";
import { PromoteToInternalDialog } from "@/components/team/PromoteToInternalDialog";
import { AssignGroupDialog } from "@/components/team/AssignGroupDialog";
import { usePermissions } from "@/hooks/usePermissions";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { Mail, Link as LinkIcon, ArrowUpRight, Shield, Users } from "lucide-react";
import { toast } from "sonner";
import { AppRole } from "@/lib/permissions";
import { normalizeError } from "@/services/resilience";

interface Props {
  employee: EmployeeProfile;
  onRefresh: () => void;
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

export function EmployeeHRSettings({ employee, onRefresh }: Props) {
  const { canManageTeam } = usePermissions();
  const { currentOrg } = useOrganization();
  const [showInviteDialog, setShowInviteDialog] = useState(false);
  const [showLinkDialog, setShowLinkDialog] = useState(false);
  const [showPromoteDialog, setShowPromoteDialog] = useState(false);
  const [showGroupDialog, setShowGroupDialog] = useState(false);

  // Fetch user role info for AssignGroupDialog when employee has a linked user
  const [memberInfo, setMemberInfo] = useState<{
    user_id: string;
    role: AppRole;
    user_type: string;
    email: string;
    full_name: string | null;
  } | null>(null);

  useEffect(() => {
    const fetchMemberInfo = async () => {
      if (!employee.user_id || !currentOrg?.id) {
        setMemberInfo(null);
        return;
      }

      try {
        const [roleRes, profileRes] = await Promise.all([
          supabase
            .from("user_roles")
            .select("role, user_type")
            .eq("user_id", employee.user_id)
            .eq("organization_id", currentOrg.id)
            .eq("is_active", true)
            .maybeSingle(),
          supabase
            .from("profiles")
            .select("email, full_name")
            .eq("id", employee.user_id)
            .maybeSingle(),
        ]);

        setMemberInfo({
          user_id: employee.user_id,
          role: (roleRes.data?.role as AppRole) || "internal",
          user_type: roleRes.data?.user_type || "internal",
          email: profileRes.data?.email || employee.email || "",
          full_name: profileRes.data?.full_name || `${employee.first_name} ${employee.last_name}`,
        });
      } catch (err) {
        console.error("Failed to fetch member info:", err);
      }
    };

    fetchMemberInfo();
  }, [employee.user_id, currentOrg?.id, employee.email, employee.first_name, employee.last_name]);

  const handlePromote = async (memberId: string, newRole: AppRole) => {
    try {
      const { error } = await (supabase as any)
        .from("organization_members")
        .update({ role: newRole })
        .eq("user_id", memberId);
      if (error) throw error;

      // `user_access_status` is now derived by DB triggers from
      // (employees.user_id, organization_invitations). Nothing to write here —
      // the trigger already reflects the promotion once the underlying identity
      // state changes. Kept as a no-op comment for clarity.


      toast.success("Employee promoted to internal user");
      onRefresh();
    } catch (error: any) {
      toast.error(normalizeError(error).message || "Failed to promote user");
      throw error;
    }
  };

  const status = employee.user_access_status || "none";

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Shield className="h-4 w-4" />
            User Access
          </CardTitle>
          <CardDescription>
            Manage this employee's system access and role
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground w-32">Access Status</span>
            <Badge variant="outline" className={ACCESS_STATUS_STYLES[status] || ACCESS_STATUS_STYLES.none}>
              {ACCESS_STATUS_LABELS[status] || "No Access"}
            </Badge>
          </div>

          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground w-32">Linked User</span>
            <span className="text-sm font-medium">
              {employee.user_id ? "Yes" : "Not linked"}
            </span>
          </div>

          {canManageTeam && (
            <div className="space-y-3 pt-2 border-t border-border">
              {/* Invite to System */}
              {!employee.user_id && (
                <div className="space-y-1">
                  <Button variant="outline" size="sm" onClick={() => setShowInviteDialog(true)}>
                    <Mail className="mr-2 h-4 w-4" />
                    Invite to System
                  </Button>
                  <p className="text-xs text-muted-foreground ml-1">
                    Send an email invitation to create a new system account
                  </p>
                </div>
              )}

              {/* Link / Change Linked Account */}
              <div className="space-y-1">
                <Button variant="outline" size="sm" onClick={() => setShowLinkDialog(true)}>
                  <LinkIcon className="mr-2 h-4 w-4" />
                  {employee.user_id ? "Change Linked Account" : "Link to Existing Account"}
                </Button>
                <p className="text-xs text-muted-foreground ml-1">
                  {employee.user_id
                    ? "Change which system user account is associated with this employee record"
                    : "Connect this employee to an already-registered user account"}
                </p>
              </div>

              {/* Access Group - only for linked employees */}
              {employee.user_id && memberInfo && (
                <div className="space-y-1">
                  <Button variant="outline" size="sm" onClick={() => setShowGroupDialog(true)}>
                    <Users className="mr-2 h-4 w-4" />
                    Access Group
                  </Button>
                  <p className="text-xs text-muted-foreground ml-1">
                    Change which permission group this user belongs to — instant, no re-invitation needed
                  </p>
                </div>
              )}

              {/* Promote to Internal */}
              {status === "portal" && (
                <div className="space-y-1">
                  <Button variant="default" size="sm" onClick={() => setShowPromoteDialog(true)}>
                    <ArrowUpRight className="mr-2 h-4 w-4" />
                    Promote to Internal
                  </Button>
                  <p className="text-xs text-muted-foreground ml-1">
                    Upgrade this portal user to a full internal user
                  </p>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Dialogs */}
      {showInviteDialog && (
        <EmployeeInviteDialog
          open={showInviteDialog}
          onOpenChange={setShowInviteDialog}
          employeeId={employee.id}
          employeeName={`${employee.first_name} ${employee.last_name}`}
          employeeEmail={employee.email}
          onSuccess={onRefresh}
        />
      )}

      {showLinkDialog && (
        <EmployeeLinkDialog
          open={showLinkDialog}
          onOpenChange={setShowLinkDialog}
          employeeId={employee.id}
          employeeName={`${employee.first_name} ${employee.last_name}`}
          currentUserId={employee.user_id}
          onSuccess={onRefresh}
        />
      )}

      {showPromoteDialog && employee.user_id && (
        <PromoteToInternalDialog
          open={showPromoteDialog}
          onOpenChange={setShowPromoteDialog}
          member={{
            id: employee.user_id,
            email: employee.email || "",
            full_name: `${employee.first_name} ${employee.last_name}`,
            role: "portal" as AppRole,
          }}
          onConfirm={handlePromote}
        />
      )}

      {showGroupDialog && memberInfo && (
        <AssignGroupDialog
          open={showGroupDialog}
          onOpenChange={(open) => {
            setShowGroupDialog(open);
            if (!open) onRefresh();
          }}
          member={{
            id: memberInfo.user_id,
            user_id: memberInfo.user_id,
            role: memberInfo.role,
            user_type: memberInfo.user_type,
            email: memberInfo.email,
            full_name: memberInfo.full_name,
          }}
        />
      )}
    </div>
  );
}
