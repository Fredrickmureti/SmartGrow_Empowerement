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
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Loader2, MapPin, Building2, Shield } from "lucide-react";
import { useBranch } from "@/contexts/BranchContext";
import { useBranchAssignments, BranchAssignment } from "@/hooks/useBranchAssignments";

interface BranchAssignmentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  member: {
    id: string;
    user_id: string;
    email: string;
    full_name: string | null;
    role: string;
  } | null;
  existingAssignments?: BranchAssignment[];
}

interface BranchSelection {
  branchId: string;
  isPrimary: boolean;
  canManage: boolean;
}

export function BranchAssignmentDialog({
  open,
  onOpenChange,
  member,
  existingAssignments = [],
}: BranchAssignmentDialogProps) {
  const { branches } = useBranch();
  const { updateAssignments, isUpdating } = useBranchAssignments(member?.user_id);
  const [selections, setSelections] = useState<BranchSelection[]>([]);

  // Initialize selections from existing assignments when dialog opens
  useEffect(() => {
    if (open && member) {
      const initial = existingAssignments.map((a) => ({
        branchId: a.branch_id,
        isPrimary: a.is_primary,
        canManage: a.can_manage,
      }));
      setSelections(initial);
    }
  }, [open, member, existingAssignments]);

  const handleBranchToggle = (branchId: string, checked: boolean) => {
    if (checked) {
      // Add branch to selections
      const isFirst = selections.length === 0;
      setSelections((prev) => [
        ...prev,
        { branchId, isPrimary: isFirst, canManage: false },
      ]);
    } else {
      // Remove branch from selections
      setSelections((prev) => {
        const filtered = prev.filter((s) => s.branchId !== branchId);
        // If we removed the primary, make the first one primary
        if (filtered.length > 0 && !filtered.some((s) => s.isPrimary)) {
          filtered[0].isPrimary = true;
        }
        return filtered;
      });
    }
  };

  const handlePrimaryChange = (branchId: string) => {
    setSelections((prev) =>
      prev.map((s) => ({
        ...s,
        isPrimary: s.branchId === branchId,
      }))
    );
  };

  const handleCanManageChange = (branchId: string, canManage: boolean) => {
    setSelections((prev) =>
      prev.map((s) =>
        s.branchId === branchId ? { ...s, canManage } : s
      )
    );
  };

  const handleSave = () => {
    if (!member) return;

    updateAssignments(
      {
        targetUserId: member.user_id,
        branchAssignments: selections,
      },
      {
        onSuccess: () => {
          onOpenChange(false);
        },
      }
    );
  };

  const isSelected = (branchId: string) =>
    selections.some((s) => s.branchId === branchId);

  const getSelection = (branchId: string) =>
    selections.find((s) => s.branchId === branchId);

  // Check if user is admin/owner (they have access to all branches automatically)
  const isAdminOrOwner = member?.role === "admin" || member?.role === "owner" || member?.role === "super_admin";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MapPin className="h-5 w-5" />
            Branch Access
          </DialogTitle>
          <DialogDescription>
            {member?.full_name || member?.email}
          </DialogDescription>
        </DialogHeader>

        {isAdminOrOwner ? (
          <div className="py-6 text-center">
            <Shield className="h-12 w-12 mx-auto text-primary/50 mb-3" />
            <p className="text-sm text-muted-foreground">
              <strong className="text-foreground">{member?.role === "owner" ? "Owners" : "Admins"}</strong> have automatic access to all branches.
            </p>
            <p className="text-xs text-muted-foreground mt-2">
              No branch assignment needed.
            </p>
          </div>
        ) : branches.length === 0 ? (
          <div className="py-6 text-center text-muted-foreground">
            <Building2 className="h-12 w-12 mx-auto opacity-50 mb-3" />
            <p className="text-sm">No branches available.</p>
            <p className="text-xs mt-1">Create branches first to assign access.</p>
          </div>
        ) : (
          <ScrollArea className="max-h-[400px] pr-4">
            <div className="space-y-4">
              {branches.map((branch) => {
                const selected = isSelected(branch.id);
                const selection = getSelection(branch.id);

                return (
                  <div
                    key={branch.id}
                    className={`rounded-lg border p-4 transition-colors ${
                      selected ? "border-primary bg-primary/5" : "border-border"
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <Checkbox
                        id={`branch-${branch.id}`}
                        checked={selected}
                        onCheckedChange={(checked) =>
                          handleBranchToggle(branch.id, checked === true)
                        }
                      />
                      <div className="flex-1 space-y-2">
                        <Label
                          htmlFor={`branch-${branch.id}`}
                          className="font-medium cursor-pointer flex items-center gap-2"
                        >
                          {branch.name}
                          {branch.is_headquarters && (
                            <Badge variant="secondary" className="text-[10px] px-1 py-0">
                              HQ
                            </Badge>
                          )}
                        </Label>

                        {selected && (
                          <div className="space-y-3 pt-2 border-t mt-2">
                            <div className="flex items-center justify-between">
                              <Label
                                htmlFor={`primary-${branch.id}`}
                                className="text-sm text-muted-foreground cursor-pointer"
                              >
                                Primary branch (default on login)
                              </Label>
                              <Switch
                                id={`primary-${branch.id}`}
                                checked={selection?.isPrimary || false}
                                onCheckedChange={() =>
                                  handlePrimaryChange(branch.id)
                                }
                              />
                            </div>

                            <div className="flex items-center justify-between">
                              <Label
                                htmlFor={`manage-${branch.id}`}
                                className="text-sm text-muted-foreground cursor-pointer"
                              >
                                Can manage branch
                              </Label>
                              <Switch
                                id={`manage-${branch.id}`}
                                checked={selection?.canManage || false}
                                onCheckedChange={(checked) =>
                                  handleCanManageChange(branch.id, checked)
                                }
                              />
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {!isAdminOrOwner && (
            <Button onClick={handleSave} disabled={isUpdating}>
              {isUpdating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save Access
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
