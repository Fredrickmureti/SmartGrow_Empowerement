import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Loader2, AlertTriangle, ArrowRight } from "lucide-react";
import { 
  AppRole, 
  ROLE_LABELS, 
  ROLE_DESCRIPTIONS,
  ROLE_PERMISSIONS,
  Permission 
} from "@/lib/permissions";
import { usePermissions } from "@/hooks/usePermissions";

interface TeamMember {
  id: string;
  user_id: string;
  role: AppRole;
  email: string;
  full_name: string | null;
}

interface EditRoleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  member: TeamMember | null;
  onConfirm: (memberId: string, newRole: AppRole) => Promise<void>;
}

const roleColors: Record<AppRole, string> = {
  super_admin: "bg-purple-500/10 text-purple-500",
  owner: "bg-primary/10 text-primary",
  admin: "bg-blue-500/10 text-blue-500",
  internal: "bg-indigo-500/10 text-indigo-500",
  accountant: "bg-green-500/10 text-green-500",
  staff: "bg-orange-500/10 text-orange-500",
  cashier: "bg-cyan-500/10 text-cyan-500",
  viewer: "bg-muted text-muted-foreground",
  portal: "bg-teal-500/10 text-teal-500",
  branch_manager: "bg-amber-500/10 text-amber-500",
  loan_officer: "bg-sky-500/10 text-sky-500",
  credit_officer: "bg-violet-500/10 text-violet-500",
  collections_officer: "bg-rose-500/10 text-rose-500",
  auditor: "bg-slate-500/10 text-slate-500",
};

// Permissions that matter for display
const KEY_PERMISSIONS: { key: Permission; label: string }[] = [
  { key: "manageTeam", label: "Manage team members" },
  { key: "editSettings", label: "Edit settings" },
  { key: "viewFinancials", label: "View financials" },
  { key: "manageFinancials", label: "Edit financials" },
  { key: "viewReports", label: "View reports" },
  { key: "viewAuditLogs", label: "View audit logs" },
];

export function EditRoleDialog({ 
  open, 
  onOpenChange, 
  member, 
  onConfirm 
}: EditRoleDialogProps) {
  const { assignableRoles, role: currentUserRole } = usePermissions();
  const [selectedRole, setSelectedRole] = useState<AppRole | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [step, setStep] = useState<1 | 2>(1);

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      setSelectedRole(null);
      setStep(1);
    }
    onOpenChange(open);
  };

  const handleNext = () => {
    if (selectedRole && selectedRole !== member?.role) {
      setStep(2);
    }
  };

  const handleConfirm = async () => {
    if (!member || !selectedRole) return;
    
    setIsSubmitting(true);
    try {
      await onConfirm(member.id, selectedRole);
      handleOpenChange(false);
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!member) return null;

  const currentRole = member.role;
  const newRole = selectedRole || currentRole;
  
  // Calculate permission changes
  const permissionChanges = KEY_PERMISSIONS.map(({ key, label }) => {
    const hadPermission = ROLE_PERMISSIONS[currentRole][key];
    const hasPermission = ROLE_PERMISSIONS[newRole][key];
    return {
      label,
      gained: !hadPermission && hasPermission,
      lost: hadPermission && !hasPermission,
      unchanged: hadPermission === hasPermission,
    };
  }).filter(p => !p.unchanged);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {step === 1 ? "Edit Member Role" : "Confirm Role Change"}
          </DialogTitle>
          <DialogDescription>
            {step === 1 
              ? `Change the role for ${member.full_name || member.email}`
              : "Review the permission changes before confirming"
            }
          </DialogDescription>
        </DialogHeader>

        {step === 1 ? (
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Current Role</Label>
              <div>
                <Badge variant="secondary" className={roleColors[currentRole]}>
                  {ROLE_LABELS[currentRole]}
                </Badge>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="new-role">New Role</Label>
              <Select
                value={selectedRole || ""}
                onValueChange={(v) => setSelectedRole(v as AppRole)}
              >
                <SelectTrigger id="new-role">
                  <SelectValue placeholder="Select a role" />
                </SelectTrigger>
                <SelectContent>
                  {assignableRoles.map((role) => (
                    <SelectItem key={role} value={role} disabled={role === currentRole}>
                      <div className="flex flex-col items-start">
                        <span>{ROLE_LABELS[role]}</span>
                        <span className="text-xs text-muted-foreground">
                          {ROLE_DESCRIPTIONS[role]}
                        </span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        ) : (
          <div className="space-y-4 py-4">
            <div className="flex items-center justify-center gap-3">
              <Badge variant="secondary" className={roleColors[currentRole]}>
                {ROLE_LABELS[currentRole]}
              </Badge>
              <ArrowRight className="h-4 w-4 text-muted-foreground" />
              <Badge variant="secondary" className={roleColors[newRole]}>
                {ROLE_LABELS[newRole]}
              </Badge>
            </div>

            {permissionChanges.length > 0 && (
              <div className="rounded-lg border p-4 space-y-3">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <AlertTriangle className="h-4 w-4 text-amber-500" />
                  Permission Changes
                </div>
                <div className="space-y-2">
                  {permissionChanges.filter(p => p.gained).length > 0 && (
                    <div>
                      <p className="text-xs font-medium text-green-600 mb-1">Will gain access to:</p>
                      <ul className="text-xs text-muted-foreground space-y-0.5">
                        {permissionChanges.filter(p => p.gained).map(p => (
                          <li key={p.label}>+ {p.label}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {permissionChanges.filter(p => p.lost).length > 0 && (
                    <div>
                      <p className="text-xs font-medium text-destructive mb-1">Will lose access to:</p>
                      <ul className="text-xs text-muted-foreground space-y-0.5">
                        {permissionChanges.filter(p => p.lost).map(p => (
                          <li key={p.label}>- {p.label}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              </div>
            )}

            <p className="text-sm text-muted-foreground text-center">
              This action will take effect immediately.
            </p>
          </div>
        )}

        <DialogFooter>
          {step === 1 ? (
            <>
              <Button variant="outline" onClick={() => handleOpenChange(false)}>
                Cancel
              </Button>
              <Button 
                onClick={handleNext}
                disabled={!selectedRole || selectedRole === currentRole}
              >
                Continue
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => setStep(1)}>
                Back
              </Button>
              <Button 
                onClick={handleConfirm}
                disabled={isSubmitting}
              >
                {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Confirm Change
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
