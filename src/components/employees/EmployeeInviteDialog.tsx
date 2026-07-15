import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { FunctionsHttpError } from "@supabase/supabase-js";
import { useOrganization } from "@/hooks/useOrganization";
import { toast } from "sonner";
import { Mail, UserPlus, Shield } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { usePermissionGroups } from "@/hooks/usePermissionGroups";
import { cn } from "@/lib/utils";
import { normalizeError } from "@/services/resilience";
import {
  WorkflowSheet,
  WorkflowSheetSection,
  WorkflowField,
} from "@/components/workflow/WorkflowSheet";

interface EmployeeInviteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  employeeId: string;
  employeeName: string;
  employeeEmail: string | null;
  onSuccess: () => void;
}

type UserType = "internal" | "portal";

const USER_TYPE_INFO: Record<UserType, { label: string; description: string }> = {
  internal: {
    label: "Internal User",
    description: "Full backend access — permissions set by Access Groups",
  },
  portal: {
    label: "Portal User",
    description: "Self-service only — payslips, leave requests, timesheets",
  },
};



export function EmployeeInviteDialog({
  open,
  onOpenChange,
  employeeId,
  employeeName,
  employeeEmail,
  onSuccess,
}: EmployeeInviteDialogProps) {
  const { currentOrg } = useOrganization();
  const { groups: availableGroups } = usePermissionGroups();
  const [email, setEmail] = useState(employeeEmail || "");
  const [userType, setUserType] = useState<UserType>("portal");
  const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const handleInvite = async () => {
    if (!email || !currentOrg) return;
    setIsLoading(true);

    try {
      const normalizedEmail = email.toLowerCase().trim();

      // Self-invite guard: refuse to send an invitation to the caller's
      // own auth email — this previously combined with portal default to
      // demote the admin into a portal user on accept.
      const { data: meRes } = await supabase.auth.getUser();
      const myEmail = meRes.user?.email?.toLowerCase().trim();
      if (myEmail && normalizedEmail === myEmail) {
        toast.error(
          "You can't send an invitation to your own email address. Use the Team page to change your own access."
        );
        setIsLoading(false);
        return;
      }

      // Idempotent server-side invitation creator. Replaces the raw insert
      // that surfaced `idx_unique_pending_invite` (23505) as a user-facing
      // "Someone else updated this record" error. Reuses pending invites,
      // detects already-active members, and only ever creates one row.
      const { data: rpcData, error: rpcError } = await supabase.rpc(
        "upsert_organization_invitation" as any,
        {
          p_organization_id: currentOrg.id,
          p_email: normalizedEmail,
          p_role: (userType === "portal" ? "portal" : "internal") as any,
          p_user_type: userType,
          p_permission_group_ids: userType === "internal" ? selectedGroupIds : null,
          p_invited_by: meRes.user?.id ?? null,
          // Explicit FK so the invitation is linked to this employee record
          // rather than inferred by email at accept-time. Also lets the DB
          // emit a `user_invited` lifecycle event against this employee.
          p_employee_id: employeeId,
        },
      );
      if (rpcError) throw rpcError;
      const result = rpcData as { status: string; invitation_id?: string; token?: string };

      if (result.status === "already_member") {
        toast.info(`${email} is already a member of this organization.`);
        setIsLoading(false);
        return;
      }

      // Only sync the employee's `email` field (used elsewhere for matching).
      // `user_access_status` is now derived by DB triggers from
      // (employees.user_id, organization_invitations) — never write it here.
      const { error: empError } = await supabase
        .from("employees")
        .update({ email: normalizedEmail })
        .eq("id", employeeId);

      if (empError) throw empError;

      // Send the invitation email via edge function
      try {
        await supabase.functions.invoke("send-invitation-email", {
          body: { invitationId: result.invitation_id },
        });
      } catch (emailErr) {
        console.error("Email send failed:", emailErr);
        toast.warning("Invitation saved but email delivery may have failed.");
      }

      toast.success(
        result.status === "reused"
          ? `Invitation refreshed and resent to ${email}`
          : `Invitation sent to ${email}`,
      );
      onSuccess();
      onOpenChange(false);
    } catch (error: any) {
      console.error("Error inviting employee:", error);
      toast.error(normalizeError(error).message || "Failed to send invitation");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <WorkflowSheet
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={
        <span className="flex items-center gap-2">
          <Mail className="h-4 w-4" />
          Invite to system — {employeeName}
        </span>
      }
      description="Send an invitation. The recipient sets their own password and inherits the access you configure here."
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleInvite} disabled={isLoading || !email}>
            <UserPlus className="h-4 w-4 mr-2" />
            {isLoading ? "Sending..." : "Send invitation"}
          </Button>
        </>
      }
    >
      <WorkflowSheetSection
        number={1}
        title="Recipient"
        subtitle="Where the invitation is sent and what kind of user is created on accept."
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <WorkflowField label="Email address" required htmlFor="invite-email">
            <Input
              id="invite-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="employee@company.com"
            />
          </WorkflowField>
          <WorkflowField label="User type" required>
            <Select value={userType} onValueChange={(v) => setUserType(v as UserType)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(USER_TYPE_INFO).map(([key, info]) => (
                  <SelectItem key={key} value={key}>
                    <div className="flex flex-col">
                      <span>{info.label}</span>
                      <span className="text-xs text-muted-foreground">{info.description}</span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </WorkflowField>
        </div>
      </WorkflowSheetSection>

      {userType === "internal" && availableGroups.length > 0 && (
        <WorkflowSheetSection
          number={2}
          title="Access groups"
          subtitle="Permissions are derived from the union of the groups selected here."
        >
          <div className="flex flex-wrap gap-2">
            {availableGroups.map((group) => (
              <label
                key={group.id}
                className={cn(
                  "inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border text-xs cursor-pointer transition-all",
                  selectedGroupIds.includes(group.id)
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border hover:border-primary/50",
                )}
              >
                <Checkbox
                  checked={selectedGroupIds.includes(group.id)}
                  onCheckedChange={(checked) => {
                    setSelectedGroupIds((prev) =>
                      checked
                        ? [...prev, group.id]
                        : prev.filter((id) => id !== group.id),
                    );
                  }}
                  className="h-3 w-3"
                />
                {group.name}
              </label>
            ))}
          </div>
        </WorkflowSheetSection>
      )}

      <WorkflowSheetSection
        number={userType === "internal" && availableGroups.length > 0 ? 3 : 2}
        title={
          <span className="flex items-center gap-2">
            <Shield className="h-4 w-4" />
            Access summary
          </span>
        }
        subtitle="What this invitation grants on accept."
      >
        <div className="rounded-lg border bg-muted/50 p-3 space-y-2">
          <div className="flex flex-wrap gap-2">
            <Badge variant="outline">{USER_TYPE_INFO[userType].label}</Badge>
            {userType === "internal" &&
              selectedGroupIds.length > 0 &&
              selectedGroupIds.map((gId) => {
                const g = availableGroups.find((gr) => gr.id === gId);
                return g ? <Badge key={gId} variant="secondary">{g.name}</Badge> : null;
              })}
          </div>
          <p className="text-xs text-muted-foreground">
            {userType === "portal"
              ? "Can view their payslips, request leave, and submit timesheets."
              : selectedGroupIds.length > 0
                ? `Access determined by ${selectedGroupIds.length} group(s).`
                : "No groups selected — will get default Internal Users permissions."}
          </p>
        </div>
      </WorkflowSheetSection>
    </WorkflowSheet>
  );
}
