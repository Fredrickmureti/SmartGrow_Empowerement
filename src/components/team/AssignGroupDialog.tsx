import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Loader2, Shield, Users } from "lucide-react";
import { usePermissionGroups } from "@/hooks/usePermissionGroups";
import { AppRole } from "@/lib/permissions";

interface TeamMember {
  id: string;
  user_id: string;
  role: AppRole;
  user_type: string;
  email: string;
  full_name: string | null;
}

interface AssignGroupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  member: TeamMember | null;
}

const SCOPE_OPTIONS: Array<{ value: BranchScopeMode; title: string; blurb: string }> = [
  { value: "all", title: "All branches", blurb: "Can work in every branch of the institution." },
  { value: "assigned", title: "Assigned branches only", blurb: "Limited to the branches this member is assigned to." },
  { value: "own_portfolio", title: "Own portfolio only", blurb: "Assigned branches, and only their own clients and loans." },
];

export function AssignGroupDialog({ open, onOpenChange, member }: AssignGroupDialogProps) {
  const { groups, assignGroups, getGroupsForUser, memberAssignments } = usePermissionGroups();
  const [selectedGroupIds, setSelectedGroupIds] = useState<Set<string>>(new Set());
  const [branchScope, setBranchScope] = useState<BranchScopeMode>("assigned");
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Every live group is assignable: the system groups ARE the microfinance
  // job roles (Loan Officer, Cashier / Teller, Branch Manager, ...). Only
  // deprecated groups are hidden from assignment.
  const assignableGroups = groups.filter((g) => !(g as { is_deprecated?: boolean }).is_deprecated);

  // Current group assignments
  const currentGroups = member ? getGroupsForUser(member.user_id) : [];
  const currentGroupIds = new Set(currentGroups.map((g) => g.id));
  // Branch scope is stored per grant; the UI edits it as one value per member.
  const currentScope: BranchScopeMode =
    (member && memberAssignments.find((a) => a.user_id === member.user_id)?.branch_scope) || "assigned";

  useEffect(() => {
    if (open && member) {
      setSelectedGroupIds(new Set(currentGroupIds));
      setBranchScope(currentScope);
    }
  }, [open, member, currentGroups.length, currentScope]);


  const toggleGroup = (groupId: string) => {
    setSelectedGroupIds((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  };

  const hasChanges = () => {
    if (selectedGroupIds.size !== currentGroupIds.size) return true;
    for (const id of selectedGroupIds) {
      if (!currentGroupIds.has(id)) return true;
    }
    return false;
  };

  const handleSave = async () => {
    if (!member) return;
    setIsSubmitting(true);
    try {
      await assignGroups.mutateAsync({
        userId: member.user_id,
        groupIds: Array.from(selectedGroupIds),
      });
      onOpenChange(false);
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!member) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Users className="h-5 w-5" />
            Assign Access Groups
          </DialogTitle>
          <DialogDescription>
            Select one or more access groups for {member.full_name || member.email}.
            Internal users' permissions are defined entirely by the union of their assigned
            groups (Odoo-aligned) — there is no base-role ceiling. Admin / Owner roles always
            have full access regardless of group assignments.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {currentGroups.length > 0 && (
            <div className="space-y-2">
              <Label>Current Groups</Label>
              <div className="flex flex-wrap gap-1">
                {currentGroups.map((g) => (
                  <Badge key={g.id} variant="secondary" className="gap-1">
                    <Shield className="h-3 w-3" />
                    {g.name}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          <div className="space-y-2">
            <Label>Available Groups</Label>
            <ScrollArea className="max-h-[300px] rounded-md border">
              <div className="p-3 space-y-2">
                {assignableGroups.length === 0 && (
                  <p className="text-sm text-muted-foreground">No access groups available.</p>
                )}
                {assignableGroups.map((group) => (
                  <label
                    key={group.id}
                    className="flex items-start gap-3 rounded-lg border p-3 cursor-pointer hover:bg-muted/50 transition-colors"
                  >
                    <Checkbox
                      checked={selectedGroupIds.has(group.id)}
                      onCheckedChange={() => toggleGroup(group.id)}
                      className="mt-0.5"
                    />
                    <div className="flex-1 space-y-0.5">
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm font-medium">{group.name}</span>
                        {group.is_system && (
                          <Badge variant="outline" className="text-[10px] px-1 py-0">System</Badge>
                        )}
                      </div>
                      {group.description && (
                        <p className="text-xs text-muted-foreground">{group.description}</p>
                      )}
                      <p className="text-xs text-muted-foreground">
                        {group.rules.length} module{group.rules.length !== 1 ? "s" : ""} configured
                      </p>
                    </div>
                  </label>
                ))}
              </div>
            </ScrollArea>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={isSubmitting || !hasChanges()}>
            {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
