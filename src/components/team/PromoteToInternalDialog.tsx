import { useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { ArrowUpRight, AlertTriangle } from "lucide-react";
import { AppRole, ROLE_LABELS, getAssignableRoles } from "@/lib/permissions";
import { usePermissions } from "@/hooks/usePermissions";

interface PromoteToInternalDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  member: { id: string; email: string; full_name: string | null; role: AppRole } | null;
  onConfirm: (memberId: string, newRole: AppRole) => Promise<void>;
}

/**
 * PromoteToInternalDialog — Explicit promotion flow for portal → internal user.
 * 
 * This enforces Odoo's design: portal users don't gradually gain permissions.
 * Instead, they are explicitly promoted to a completely different user world.
 * After promotion, on next login they see the full internal dashboard.
 */
export function PromoteToInternalDialog({
  open,
  onOpenChange,
  member,
  onConfirm,
}: PromoteToInternalDialogProps) {
  const [selectedRole, setSelectedRole] = useState<AppRole>("internal");
  const [isLoading, setIsLoading] = useState(false);
  const { role: currentUserRole } = usePermissions();

  const assignableRoles = getAssignableRoles(currentUserRole);

  const handleConfirm = async () => {
    if (!member) return;
    setIsLoading(true);
    try {
      await onConfirm(member.id, selectedRole);
      onOpenChange(false);
    } catch {
      // Error handled by parent
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <ArrowUpRight className="h-5 w-5 text-primary" />
            Promote to Internal User
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3">
              <p>
                You are about to promote <strong>{member?.full_name || member?.email}</strong> from
                a <Badge variant="outline" className="mx-1">Portal User</Badge> to an
                <Badge variant="outline" className="mx-1">Internal User</Badge>.
              </p>

              <div className="rounded-md border border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950 p-3 text-sm">
                <div className="flex gap-2">
                  <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
                  <div>
                    <p className="font-medium text-amber-800 dark:text-amber-200">This is a major change</p>
                    <ul className="mt-1 list-disc pl-4 text-amber-700 dark:text-amber-300 space-y-1">
                      <li>They will lose access to the self-service portal</li>
                      <li>On next login, they will see the full internal dashboard</li>
                      <li>They will be able to access business apps based on their new role</li>
                      <li>This action cannot be easily undone</li>
                    </ul>
                  </div>
                </div>
              </div>

              <div className="space-y-2 pt-1">
                <Label>Assign internal role</Label>
                <Select value={selectedRole} onValueChange={(v) => setSelectedRole(v as AppRole)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {assignableRoles.map((role) => (
                      <SelectItem key={role} value={role}>
                        {ROLE_LABELS[role]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isLoading}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={handleConfirm} disabled={isLoading}>
            {isLoading ? "Promoting..." : "Promote to Internal"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
