// Wave H F4: candidate-list assembly is now a single SECURITY DEFINER RPC
// (`public.get_linkable_users_for_employee`). The picker no longer reads
// `organizations`, `user_roles`, `profiles`, `employees`, or
// `platform_admins` directly — the server returns pre-classified rows with
// masked emails, gated on `hr.write` permission. Write paths
// (`link_employee_to_user` / `unlink_employee_from_user`) are unchanged.

import { useState, useEffect, useRef } from "react";
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
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { toast } from "sonner";
import { UserCircle, Link as LinkIcon, Unlink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { normalizeError } from "@/services/resilience";
import {
  WorkflowSheet,
  WorkflowSheetSection,
} from "@/components/workflow/WorkflowSheet";


interface UserProfile {
  user_id: string;
  /** Server-masked email (e.g. `a***@example.com`). Full address is never sent to the client. */
  email: string;
  full_name: string | null;
  /**
   * `eligible` — safe to link (portal user, or unlinked internal staff
   *   without owner/admin role).
   * `blocked`  — workspace owner, active admin/super_admin/internal,
   *   platform admin, or the caller themselves. Never selectable.
   * `already_linked` — already linked to a different employee in this
   *   org. Never selectable.
   */
  linkability: "eligible" | "blocked" | "already_linked";
  /** Human reason shown in the disabled item's tooltip / badge. */
  blockReason?: string;
}

interface EmployeeLinkDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  employeeId: string;
  employeeName: string;
  currentUserId: string | null;
  onSuccess: () => void;
}

export function EmployeeLinkDialog({
  open,
  onOpenChange,
  employeeId,
  employeeName,
  currentUserId,
  onSuccess,
}: EmployeeLinkDialogProps) {
  const { currentOrg } = useOrganization();
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<string>(currentUserId || "");
  const [isLoading, setIsLoading] = useState(false);
  const [isFetching, setIsFetching] = useState(true);
  const [showProtected, setShowProtected] = useState(false);
  const [showUnlinkConfirm, setShowUnlinkConfirm] = useState(false);
  const lastUnlinkedUserRef = useRef<UserProfile | null>(null);

  // Fetch organization members
  useEffect(() => {
    const fetchUsers = async () => {
      if (!currentOrg || !open) return;
      setIsFetching(true);

      try {
        // Wave H F4: single SECURITY DEFINER RPC. The server gates on
        // hr.write, runs the privilege classification, and masks email
        // before returning — see migration 20260608-* for the body.
        const { data, error } = await supabase.rpc(
          "get_linkable_users_for_employee" as any,
          { p_org_id: currentOrg.id, p_employee_id: employeeId },
        );

        if (error) throw error;

        const rows = (data || []) as Array<{
          user_id: string;
          display_name: string | null;
          email_masked: string;
          linkability: "eligible" | "blocked" | "already_linked";
          block_reason: string | null;
        }>;

        const classified: UserProfile[] = rows.map((r) => ({
          user_id: r.user_id,
          email: r.email_masked || "",
          full_name: r.display_name,
          linkability: r.linkability,
          blockReason: r.block_reason ?? undefined,
        }));

        setUsers(classified);
      } catch (error: any) {
        // Surface the real RPC error (permission denied, etc.) instead of a
        // generic toast so future regressions are diagnosable from the UI.
        console.error("Error fetching users:", error);
        const msg = normalizeError(error).message || error?.message || "Failed to load users";
        toast.error(msg);
      } finally {
        setIsFetching(false);
      }
    };

    fetchUsers();
  }, [currentOrg?.id, open, employeeId, currentUserId]);


  const handleLink = async (force = false) => {
    if (!selectedUserId) return;
    setIsLoading(true);

    try {
      // Single audited entry point. The RPC will refuse to link the
      // workspace owner, a platform admin, or the caller themselves
      // without an explicit force=true confirmation — that's what prevents
      // an HR admin from accidentally turning their own account into a
      // portal employee row.
      const { error } = await supabase.rpc("link_employee_to_user" as any, {
        p_employee_id: employeeId,
        p_user_id: selectedUserId,
        p_force: force,
      });

      if (error) {
        // Surface the "needs confirmation" path as a confirm prompt rather
        // than a generic error.
        const msg = error.message || "";
        if (msg.includes("Re-submit with confirm=true")) {
          if (window.confirm(msg + "\n\nProceed anyway?")) {
            return handleLink(true);
          }
          return;
        }
        throw error;
      }

      toast.success("Employee linked to user account");
      onSuccess();
      onOpenChange(false);
    } catch (error: any) {
      console.error("Error linking employee:", error);
      toast.error(normalizeError(error).message || "Failed to link employee");
    } finally {
      setIsLoading(false);
    }
  };


  const handleUnlinkClick = () => {
    setShowUnlinkConfirm(true);
  };

  const handleUnlinkConfirmed = async () => {
    setShowUnlinkConfirm(false);
    setIsLoading(true);

    try {
      // Remember the unlinked user so they can easily re-link
      const unlinkedUser = users.find((u) => u.user_id === currentUserId);
      if (unlinkedUser) {
        lastUnlinkedUserRef.current = unlinkedUser;
      }


      const { error } = await supabase.rpc("unlink_employee_from_user" as any, {
        p_employee_id: employeeId,
      });

      if (error) throw error;


      toast.success(
        "Employee unlinked. You can re-link the same user anytime — no new invite needed.",
        { duration: 5000 }
      );
      setSelectedUserId("");
      onSuccess();
      onOpenChange(false);
    } catch (error: any) {
      console.error("Error unlinking employee:", error);
      toast.error(normalizeError(error).message || "Failed to unlink employee");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <>
    <WorkflowSheet
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title={
        <span className="flex items-center gap-2">
          <UserCircle className="h-5 w-5" />
          Link Employee to User Account
        </span>
      }
      description={
        <>
          Associate <strong>{employeeName}</strong>'s employee record with a system user account. This is a database link — it does not change permissions or send invitations. To change permissions, use the <strong>Access Group</strong> button instead.
        </>
      }
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          <div>
            {currentUserId && (
              <Button
                variant="outline"
                onClick={handleUnlinkClick}
                disabled={isLoading}
                className="text-destructive hover:text-destructive"
              >
                <Unlink className="h-4 w-4 mr-2" />
                Unlink
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => handleLink(false)}
              disabled={isLoading || !selectedUserId || selectedUserId === currentUserId}
            >
              <LinkIcon className="h-4 w-4 mr-2" />
              {isLoading ? "Linking..." : "Link Account"}
            </Button>
          </div>
        </div>
      }
    >
      <div
        className="rounded-md border border-amber-500/40 bg-amber-50 dark:bg-amber-950/30 p-3 text-xs text-amber-900 dark:text-amber-200"
        data-testid="link-protected-notice"
      >
        Owners, administrators, internal users, and platform admins are
        not available for linking. Change a user's role in{" "}
        <strong>Team &amp; Permissions</strong> first.
      </div>

      {currentUserId && (
        <div className="rounded-lg border bg-muted/50 p-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <LinkIcon className="h-4 w-4 text-green-500" />
              <span className="text-sm">Currently linked to:</span>
            </div>
            <Badge variant="secondary">
              {users.find((u) => u.user_id === currentUserId)?.email || "User"}
            </Badge>
          </div>
        </div>
      )}

      <WorkflowSheetSection
        number={1}
        title="Select user account"
        subtitle="Only active, portal-eligible members not already linked to another employee are shown."
        right={
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
            <input
              type="checkbox"
              className="h-3.5 w-3.5"
              checked={showProtected}
              onChange={(e) => setShowProtected(e.target.checked)}
              data-testid="show-protected-toggle"
            />
            Show protected
          </label>
        }
      >
        <div className="space-y-2">
          <Label htmlFor="user-select" className="sr-only">Select User Account</Label>
          <Select
            value={selectedUserId}
            onValueChange={setSelectedUserId}
            disabled={isFetching}
          >
            <SelectTrigger>
              <SelectValue placeholder={isFetching ? "Loading users..." : "Select a user"} />
            </SelectTrigger>
            <SelectContent>
              {users
                .filter((u) => {
                  if (u.user_id === currentUserId) return true;
                  if (u.linkability === "eligible") return true;
                  if (u.linkability === "already_linked") return false;
                  return showProtected;
                })
                .map((user) => {
                  const disabled =
                    user.linkability !== "eligible" &&
                    user.user_id !== currentUserId;
                  return (
                    <SelectItem
                      key={user.user_id}
                      value={user.user_id}
                      disabled={disabled}
                      title={user.blockReason || undefined}
                    >
                      <div className="flex items-center justify-between gap-3 w-full">
                        <div className="flex flex-col min-w-0">
                          <span className="truncate">{user.full_name || user.email}</span>
                          {user.full_name && (
                            <span className="text-xs text-muted-foreground truncate">{user.email}</span>
                          )}
                        </div>
                        {disabled && user.blockReason && (
                          <Badge variant="destructive" className="text-[10px] shrink-0">
                            Protected
                          </Badge>
                        )}
                      </div>
                    </SelectItem>
                  );
                })}

              {users.filter((u) => u.linkability === "eligible").length === 0 && !isFetching && (
                <div className="p-2 text-sm text-muted-foreground text-center">
                  No eligible users. Invite the employee instead, or change an
                  existing user's role to portal.
                </div>
              )}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Suspended (inactive) members are hidden to prevent broken portal access.
          </p>
        </div>
      </WorkflowSheetSection>
    </WorkflowSheet>


    {/* Unlink confirmation */}
    <AlertDialog open={showUnlinkConfirm} onOpenChange={setShowUnlinkConfirm}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Unlink User Account?</AlertDialogTitle>
          <AlertDialogDescription className="space-y-2">
            <span className="block">
              This will remove <strong>{employeeName}</strong>'s connection to their user account. They will <strong>lose access</strong> to the employee portal (leave requests, timesheets, approvals) until re-linked.
            </span>
            <span className="block text-sm">
              💡 You can re-link the same user later from this dialog — no new invite is needed.
            </span>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleUnlinkConfirmed}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            Unlink
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    </>
  );
}
