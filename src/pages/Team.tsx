import { useState, useEffect } from "react";
import { PlatformAppLayout } from "@/apps/platform";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { usePermissions } from "@/hooks/usePermissions";
import { useAuth } from "@/contexts/AuthContext";
import { useBranchAssignments } from "@/hooks/useBranchAssignments";
import { useBranches } from "@/hooks/useBranches";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { ToastAction } from "@/components/ui/toast";
import { useToast } from "@/hooks/use-toast";
import { 
  Loader2, 
  UserPlus, 
  Mail, 
  Clock, 
  Copy,
  RefreshCw, 
  Trash2, 
  MoreHorizontal,
  Pencil,
  UserMinus,
  Shield,
  MapPin,
  ArrowUpRight,
  Users,
  Building2
} from "lucide-react";
import { Database } from "@/integrations/supabase/types";
import { EditRoleDialog } from "@/components/team/EditRoleDialog";
import { RemoveMemberDialog } from "@/components/team/RemoveMemberDialog";
import { BranchAssignmentDialog } from "@/components/team/BranchAssignmentDialog";
import {
  buildInvitationAcceptUrl,
  copyInvitationLink,
  InvitationEmailError,
  sendInvitationEmailOrThrow,
} from "@/lib/invitations/sendInvitationEmail";
import { BusinessAccessDialog } from "@/components/team/BusinessAccessDialog";
import { PromoteToInternalDialog } from "@/components/team/PromoteToInternalDialog";
import { AssignGroupDialog } from "@/components/team/AssignGroupDialog";
import { ROLE_LABELS, canManageRole, AppRole } from "@/lib/permissions";
import { normalizeError } from "@/services/resilience";

interface TeamMember {
  id: string;
  user_id: string;
  role: AppRole;
  user_type: string;
  email: string;
  full_name: string | null;
}

interface Invitation {
  id: string;
  email: string;
  role: AppRole;
  token?: string | null;
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
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

export default function Team() {
  const { currentOrg, userRole } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { user } = useAuth();
  const { canManageTeam, role: currentUserRole, canManage } = usePermissions();
  const { toast } = useToast();
  const { assignmentsByUser, refetchAll } = useBranchAssignments();
  const { branches } = useBranches();
  
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  // Protected (DB-enforced) owner of this organization. Loaded from
  // organizations.owner_user_id — anyone holding the 'owner' role row that
  // matches this id cannot be modified through the normal team UI.
  const [protectedOwnerId, setProtectedOwnerId] = useState<string | null>(null);
  const [showInviteDialog, setShowInviteDialog] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<AppRole>("internal");
  const [inviteGroupIds, setInviteGroupIds] = useState<string[]>([]);
  // Branch scope carried by the invitation (Wave 2). The acceptance RPC turns
  // these into real branch assignments, so a new user is never branch-less.
  const [inviteBranchIds, setInviteBranchIds] = useState<string[]>([]);
  const [invitePrimaryBranchId, setInvitePrimaryBranchId] = useState<string | null>(null);
  const [inviteBranchScope, setInviteBranchScope] = useState<"all" | "assigned" | "own_portfolio">("assigned");
  const [availableGroups, setAvailableGroups] = useState<Array<{ id: string; name: string; description: string | null }>>([]);
  const [isInviting, setIsInviting] = useState(false);
  // Per-row inline role change loading.
  const [inlineRoleUpdatingId, setInlineRoleUpdatingId] = useState<string | null>(null);
  const [resendingId, setResendingId] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  
  // Duplicate invitation dialog state
  const [showDuplicateDialog, setShowDuplicateDialog] = useState(false);
  const [existingInvitation, setExistingInvitation] = useState<Invitation | null>(null);

  // Revoke confirmation dialog state
  const [showRevokeDialog, setShowRevokeDialog] = useState(false);
  const [invitationToRevoke, setInvitationToRevoke] = useState<Invitation | null>(null);

  // Edit role dialog state
  const [showEditRoleDialog, setShowEditRoleDialog] = useState(false);
  const [memberToEdit, setMemberToEdit] = useState<TeamMember | null>(null);

  // Remove member dialog state
  const [showRemoveMemberDialog, setShowRemoveMemberDialog] = useState(false);
  const [memberToRemove, setMemberToRemove] = useState<TeamMember | null>(null);

  // Branch assignment dialog state
  const [showBranchDialog, setShowBranchDialog] = useState(false);
  const [memberForBranch, setMemberForBranch] = useState<TeamMember | null>(null);

  // Promote to internal dialog state
  const [showPromoteDialog, setShowPromoteDialog] = useState(false);
  const [memberToPromote, setMemberToPromote] = useState<TeamMember | null>(null);

  // Assign group dialog state
  const [showAssignGroupDialog, setShowAssignGroupDialog] = useState(false);
  const [memberForGroup, setMemberForGroup] = useState<TeamMember | null>(null);

  // Business access dialog state
  const [showBusinessAccessDialog, setShowBusinessAccessDialog] = useState(false);
  const [memberForBusinessAccess, setMemberForBusinessAccess] = useState<TeamMember | null>(null);

  useEffect(() => {
    if (currentOrg) {
      fetchTeamData();
      fetchAvailableGroups();
    }
  }, [currentOrg]);

  const fetchAvailableGroups = async () => {
    if (!currentOrg || !currentBusiness) return;
    const { data } = await supabase
      .from("permission_groups")
      .select("id, name, description")
      .eq("organization_id", currentOrg.id)
      .order("is_system", { ascending: false })
      .order("name");
    setAvailableGroups(data || []);
  };

  const fetchTeamData = async () => {
    if (!currentOrg) return;
    setIsLoading(true);

    try {
      // Step 0: Fetch the protected owner of this organization
      const { data: orgData } = await supabase
        // SCOPE-EXEMPT: `organizations` is workspace-wide (no business_id column)
        .from("organizations")
        .select("owner_user_id")
        .eq("id", currentOrg.id)
        .maybeSingle();
      setProtectedOwnerId(orgData?.owner_user_id ?? null);

      // Step 1: Fetch user_roles
      const { data: rolesData, error: rolesError } = await supabase
        .from("user_roles")
        .select("id, user_id, role, user_type")
        .eq("organization_id", currentOrg.id)
        .eq("is_active", true);

      if (rolesError) throw rolesError;

      // Step 2: Fetch profiles for those users
      const userIds = (rolesData || []).map(r => r.user_id);
      let profilesMap = new Map<string, { email: string; full_name: string | null }>();
      
      if (userIds.length > 0) {
        const { data: profilesData } = await supabase
          // SCOPE-EXEMPT: `profiles` is workspace-wide (no business_id column)
          .from("profiles")
          .select("user_id, email, full_name")
          .in("user_id", userIds);
        
        profilesMap = new Map(
          (profilesData || []).map(p => [p.user_id, { email: p.email, full_name: p.full_name }])
        );
      }

      // Step 3: Merge data
      const teamMembers: TeamMember[] = (rolesData || []).map((r) => ({
        id: r.id,
        user_id: r.user_id,
        role: r.role,
        user_type: r.user_type || (r.role === 'portal' ? 'portal' : 'internal'),
        email: profilesMap.get(r.user_id)?.email || 'Unknown',
        full_name: profilesMap.get(r.user_id)?.full_name || null,
      }));
      setMembers(teamMembers);

      // Fetch pending invitations
      const { data: invitesData, error: invitesError } = await supabase
        // SCOPE-EXEMPT: "organization_invitations" is workspace-wide (not in BUSINESS_SCOPED_TABLES)
        .from("organization_invitations")
        .select("*")
        .eq("organization_id", currentOrg.id)
        .is("accepted_at", null)
        .gt("expires_at", new Date().toISOString());

      if (invitesError) throw invitesError;
      setInvitations(invitesData || []);
    } catch (error: any) {
      console.error("Error fetching team:", error);
      toast({
        title: "Error",
        description: "Failed to load team data",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const checkExistingInvitation = async (email: string): Promise<Invitation | null> => {
    if (!currentOrg) return null;

    const { data } = await supabase
      .from("organization_invitations")
      .select("*")
      .eq("organization_id", currentOrg.id)
      .eq("email", email.toLowerCase())
      .is("accepted_at", null)
      .gt("expires_at", new Date().toISOString())
      .maybeSingle();

    return data as Invitation | null;
  };

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentOrg || !canManageTeam) return;

    setIsInviting(true);
    try {
      // Server-side user-count enforcement
      const { data: limitCheck, error: limitErr } = await (supabase as any)
        .rpc("check_user_invite_allowed", { p_organization_id: currentOrg.id });
      if (limitErr) throw limitErr;
      const limit = limitCheck as { allowed: boolean; reason: string } | null;
      if (limit && !limit.allowed) {
        toast({
          title: "User limit reached",
          description: limit.reason || "Upgrade your plan to add more users.",
          variant: "destructive",
        });
        setIsInviting(false);
        return;
      }

      await createAndSendInvitation();
    } catch (error: any) {
      toast({
        title: "Error",
        description: normalizeError(error).message || "Failed to send invitation",
        variant: "destructive",
      });
    } finally {
      setIsInviting(false);
    }
  };

  const createAndSendInvitation = async () => {
    if (!currentOrg) return;

    // Idempotent server-side invitation creator. Returns one of:
    //   - already_member  : email is already an active member
    //   - reused          : a pending invite existed; updated + token returned
    //   - created         : brand-new invite row
    // This replaces the previous raw INSERT which surfaced
    // `idx_unique_pending_invite` (23505) as a user-facing 409 conflict.
    const { data: meRes } = await supabase.auth.getUser();
    const { data: rpcData, error: rpcError } = await (supabase as any).rpc(
      "upsert_organization_invitation",
      {
        p_organization_id: currentOrg.id,
        p_email: inviteEmail.toLowerCase().trim(),
        p_role: inviteRole as any,
        p_user_type: "internal",
        p_permission_group_ids: inviteGroupIds.length > 0 ? inviteGroupIds : null,
        p_invited_by: meRes.user?.id ?? null,
        p_branch_ids: inviteRole === "internal" && inviteBranchIds.length > 0 ? inviteBranchIds : null,
        p_primary_branch_id: inviteRole === "internal" ? invitePrimaryBranchId : null,
        p_branch_scope: inviteRole === "internal" ? inviteBranchScope : "all",
      },
    );
    if (rpcError) throw rpcError;
    const result = rpcData as { status: string; invitation_id?: string; user_id?: string; token?: string };

    if (result.status === "already_member") {
      toast({
        title: "Already a member",
        description: `${inviteEmail} is already a member of this organization.`,
        variant: "destructive",
      });
      return;
    }

    let emailFailureReason: string | null = null;
    let acceptUrl = buildInvitationAcceptUrl(result.token);
    if (result.invitation_id) {
      try {
        const delivery = await sendInvitationEmailOrThrow(result.invitation_id);
        acceptUrl = delivery.acceptUrl || acceptUrl;
      } catch (emailError: any) {
        emailFailureReason = emailError?.message ?? "unknown_error";
        if (emailError instanceof InvitationEmailError) {
          acceptUrl = emailError.acceptUrl || acceptUrl;
        }
        console.error("Failed to send invitation email:", emailError);
      }
    }

    toast({
      title: emailFailureReason
        ? "Invitation saved, email failed"
        : result.status === "reused"
          ? "Invitation already pending"
          : "Invitation sent",
      description: emailFailureReason
        ? `The invitation was saved for ${inviteEmail}, but the email did not send: ${emailFailureReason.slice(0, 220)}`
        : result.status === "reused"
          ? `Invitation email resent to ${inviteEmail}.`
          : `Invitation sent to ${inviteEmail}`,
      variant: emailFailureReason ? "destructive" : undefined,
      action: acceptUrl
        ? (
            <ToastAction
              altText="Copy invitation link"
              onClick={() => void copyInvitationLink(acceptUrl).then(
              () => toast({ title: "Invitation link copied" }),
              () => toast({ title: "Copy failed", variant: "destructive" }),
            )}
            >
              Copy link
            </ToastAction>
          )
        : undefined,
    });

    setShowInviteDialog(false);
    setInviteEmail("");
    setInviteRole("internal");
    setInviteGroupIds([]);
    setInviteBranchIds([]);
    setInvitePrimaryBranchId(null);
    setInviteBranchScope("assigned");
    fetchTeamData();
  };


  const handleResendFromDuplicateDialog = async () => {
    if (!existingInvitation) return;
    
    setShowDuplicateDialog(false);
    await handleResendInvitation(existingInvitation.id, existingInvitation.email, existingInvitation.token);
    setExistingInvitation(null);
    setShowInviteDialog(false);
    setInviteEmail("");
    setInviteRole("internal");
  };

  const handleResendInvitation = async (invitationId: string, email: string, token?: string | null) => {
    setResendingId(invitationId);
    try {
      const delivery = await sendInvitationEmailOrThrow(invitationId);
      const acceptUrl = delivery.acceptUrl || buildInvitationAcceptUrl(token);

      toast({
        title: "Invitation resent",
        description: `Invitation email resent to ${email}`,
        action: acceptUrl
          ? (
              <ToastAction
                altText="Copy invitation link"
                onClick={() => void copyInvitationLink(acceptUrl).then(
                () => toast({ title: "Invitation link copied" }),
                () => toast({ title: "Copy failed", variant: "destructive" }),
              )}
              >
                Copy link
              </ToastAction>
            )
          : undefined,
      });
    } catch (error: any) {
      const acceptUrl = error instanceof InvitationEmailError
        ? error.acceptUrl || buildInvitationAcceptUrl(token)
        : buildInvitationAcceptUrl(token);
      console.error("Failed to resend invitation:", error);
      toast({
        title: "Error",
        description: normalizeError(error).message || "Failed to resend invitation email",
        variant: "destructive",
        action: acceptUrl
          ? (
              <ToastAction
                altText="Copy invitation link"
                onClick={() => void copyInvitationLink(acceptUrl).then(
                () => toast({ title: "Invitation link copied" }),
                () => toast({ title: "Copy failed", variant: "destructive" }),
              )}
              >
                Copy link
              </ToastAction>
            )
          : undefined,
      });
    } finally {
      setResendingId(null);
    }
  };

  const handleRevokeInvitation = async (invitationId: string, email: string) => {
    setRevokingId(invitationId);
    try {
      const { error } = await supabase
        .from("organization_invitations")
        .delete()
        .eq("id", invitationId);

      if (error) throw error;

      toast({
        title: "Invitation revoked",
        description: `Invitation to ${email} has been cancelled`,
      });

      fetchTeamData();
    } catch (error: any) {
      console.error("Failed to revoke invitation:", error);
      toast({
        title: "Error",
        description: "Failed to revoke invitation",
        variant: "destructive",
      });
    } finally {
      setRevokingId(null);
    }
  };

  const handleUpdateRole = async (memberId: string, newRole: AppRole) => {
    if (!currentOrg) return;

    try {
      const { error } = await supabase
        .from("user_roles")
        .update({ role: newRole, updated_at: new Date().toISOString() })
        .eq("id", memberId);

      if (error) throw error;

      // Log the action
      await supabase.from("audit_logs").insert({
        organization_id: currentOrg.id,
        user_id: user?.id,
        entity_type: "user_role",
        entity_id: memberId,
        action: "role_updated",
        new_values: { role: newRole },
        old_values: { role: memberToEdit?.role },
        changes_summary: `Changed role from ${memberToEdit?.role} to ${newRole}`,
      });

      toast({
        title: "Role updated",
        description: `Successfully updated role to ${ROLE_LABELS[newRole]}`,
      });

      fetchTeamData();
    } catch (error: any) {
      console.error("Failed to update role:", error);
      toast({
        title: "Error",
        description: normalizeError(error).message || "Failed to update role",
        variant: "destructive",
      });
      throw error;
    }
  };

  const handleRemoveMember = async (memberId: string) => {
    if (!currentOrg) return;

    try {
      // Soft delete by setting is_active to false
      const { error } = await supabase
        .from("user_roles")
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq("id", memberId);

      if (error) throw error;

      // Log the action
      await supabase.from("audit_logs").insert({
        organization_id: currentOrg.id,
        user_id: user?.id,
        entity_type: "user_role",
        entity_id: memberId,
        action: "member_removed",
        old_values: { 
          email: memberToRemove?.email, 
          role: memberToRemove?.role 
        },
        changes_summary: `Removed ${memberToRemove?.email} from organization`,
      });

      toast({
        title: "Member removed",
        description: `${memberToRemove?.email} has been removed from the organization`,
      });

      fetchTeamData();
    } catch (error: any) {
      console.error("Failed to remove member:", error);
      toast({
        title: "Error",
        description: normalizeError(error).message || "Failed to remove member",
        variant: "destructive",
      });
      throw error;
    }
  };

  const handlePromoteToInternal = async (memberId: string, newRole: AppRole) => {
    if (!currentOrg) return;

    try {
      const member = members.find(m => m.id === memberId);
      const { data, error } = await supabase.rpc("promote_to_internal_user", {
        p_user_id: member!.user_id,
        p_org_id: currentOrg.id,
        p_new_role: newRole,
      });

      if (error) throw error;

      // Log the action
      await supabase.from("audit_logs").insert({
        organization_id: currentOrg.id,
        user_id: user?.id,
        entity_type: "user_role",
        entity_id: memberId,
        action: "promoted_to_internal",
        old_values: { role: "portal", user_type: "portal" },
        new_values: { role: newRole, user_type: "internal" },
        changes_summary: `Promoted portal user ${member?.email} to internal ${ROLE_LABELS[newRole]}`,
      });

      toast({
        title: "User promoted",
        description: `${member?.email} is now an internal user with the ${ROLE_LABELS[newRole]} role. They will see the internal dashboard on next login.`,
      });

      fetchTeamData();
    } catch (error: any) {
      console.error("Failed to promote user:", error);
      toast({
        title: "Error",
        description: normalizeError(error).message || "Failed to promote user",
        variant: "destructive",
      });
      throw error;
    }
  };

  // Check if current user can manage a specific member.
  // The protected organization owner (organizations.owner_user_id) is
  // immutable through the team UI — DB triggers also block any direct
  // mutation. To change ownership, use Transfer Ownership.
  const canManageMember = (member: TeamMember): boolean => {
    if (!canManageTeam) return false;
    if (member.user_id === user?.id) return false; // Can't manage yourself
    if (protectedOwnerId && member.user_id === protectedOwnerId) return false;
    return canManage(member.role);
  };

  if (isLoading) {
    return (
      <PlatformAppLayout>
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </PlatformAppLayout>
    );
  }

  // Mirror of the database invitation rules (upsert_organization_invitation).
  // The server is authoritative; this only stops the user submitting an
  // invitation the database will reject.
  const isOwner = currentUserRole === "owner" || (!!user?.id && user.id === protectedOwnerId);
  const inviteNeedsGroup = inviteRole === "internal" && inviteGroupIds.length === 0;
  const inviteNeedsBranch =
    inviteRole === "internal" &&
    inviteBranchScope !== "all" &&
    inviteBranchIds.length === 0;
  const inviteAdminBlocked = inviteRole === "admin" && !isOwner;
  const inviteInvalid = inviteNeedsGroup || inviteNeedsBranch || inviteAdminBlocked;

  return (
    <PlatformAppLayout>
      <div className="space-y-6 sm:space-y-8">
        <div className="page-header">
          <div>
            <h1 className="page-title">Team</h1>
            <p className="text-sm sm:text-base text-muted-foreground">
              Manage your organization's team members and invitations
            </p>
          </div>
          {canManageTeam && (
            <>
              <Button
                className="w-full sm:w-auto"
                onClick={() => setShowInviteDialog(true)}
              >
                <UserPlus className="mr-2 h-4 w-4" />
                Invite Member
              </Button>
              <Dialog open={showInviteDialog} onOpenChange={setShowInviteDialog}>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Invite Team Member</DialogTitle>
                    <DialogDescription>
                      Send an invitation to join your organization
                    </DialogDescription>
                  </DialogHeader>
                  <form onSubmit={handleInvite} className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="email">Email Address</Label>
                      <Input
                        id="email"
                        type="email"
                        placeholder="colleague@example.com"
                        value={inviteEmail}
                        onChange={(e) => setInviteEmail(e.target.value)}
                        required
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Role preset</Label>
                      <div className="grid grid-cols-2 gap-2">
                        {([
                          {
                            value: "admin" as AppRole,
                            title: "Admin",
                            blurb: "Full access. Can manage the team and every module.",
                          },
                          {
                            value: "internal" as AppRole,
                            title: "Internal user",
                            blurb: "Access only to the groups you assign below.",
                          },
                        ]).map((preset) => {
                          const selected = inviteRole === preset.value;
                          const blocked = preset.value === "admin" && !isOwner;
                          return (
                            <button
                              type="button"
                              key={preset.value}
                              disabled={blocked}
                              onClick={() => setInviteRole(preset.value)}
                              className={`text-left rounded-md border p-3 transition ${
                                blocked
                                  ? "opacity-50 cursor-not-allowed"
                                  : selected
                                    ? "border-primary ring-2 ring-primary/30"
                                    : "hover:border-foreground/30"
                              }`}
                            >
                              <p className="font-medium text-sm">{preset.title}</p>
                              <p className="text-xs text-muted-foreground mt-1">
                                {blocked
                                  ? "Only the institution owner can invite an administrator."
                                  : preset.blurb}
                              </p>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                    {inviteRole === "internal" && availableGroups.length > 0 && (
                      <div className="space-y-2">
                        <Label>Access Groups</Label>
                        <div className="rounded-md border max-h-56 overflow-y-auto divide-y">
                          {availableGroups.map((g) => {
                            const checked = inviteGroupIds.includes(g.id);
                            return (
                              <label
                                key={g.id}
                                className="flex items-start gap-3 p-3 cursor-pointer hover:bg-muted/50"
                              >
                                <input
                                  type="checkbox"
                                  className="mt-1"
                                  checked={checked}
                                  onChange={(e) => {
                                    setInviteGroupIds((prev) =>
                                      e.target.checked
                                        ? [...prev, g.id]
                                        : prev.filter((id) => id !== g.id),
                                    );
                                  }}
                                />
                                <div className="flex-1 min-w-0">
                                  <p className="text-sm font-medium">{g.name}</p>
                                  {g.description && (
                                    <p className="text-xs text-muted-foreground">{g.description}</p>
                                  )}
                                </div>
                              </label>
                            );
                          })}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          Select one or more groups to grant module access (e.g. Payroll Admin to manage payroll).
                          You can change these later from the member's row.
                        </p>
                      </div>
                    )}
                    {inviteRole === "internal" && (
                      <div className="space-y-2">
                        <Label>Branch access</Label>
                        <div className="grid grid-cols-1 gap-2">
                          {([
                            { value: "all" as const, title: "All branches", blurb: "Can work in every branch of the institution." },
                            { value: "assigned" as const, title: "Assigned branches only", blurb: "Can only work in the branches selected below." },
                            { value: "own_portfolio" as const, title: "Own portfolio only", blurb: "Assigned branches, limited to their own clients and loans." },
                          ]).map((opt) => (
                            <button
                              type="button"
                              key={opt.value}
                              onClick={() => setInviteBranchScope(opt.value)}
                              className={`text-left rounded-md border p-3 transition ${
                                inviteBranchScope === opt.value
                                  ? "border-primary ring-2 ring-primary/30"
                                  : "hover:border-foreground/30"
                              }`}
                            >
                              <p className="font-medium text-sm">{opt.title}</p>
                              <p className="text-xs text-muted-foreground mt-1">{opt.blurb}</p>
                            </button>
                          ))}
                        </div>
                        {inviteBranchScope !== "all" && branches.length > 0 && (
                          <div className="rounded-md border max-h-48 overflow-y-auto divide-y">
                            {branches.map((b) => {
                              const checked = inviteBranchIds.includes(b.id);
                              return (
                                <label
                                  key={b.id}
                                  className="flex items-center gap-3 p-3 cursor-pointer hover:bg-muted/50"
                                >
                                  <input
                                    type="checkbox"
                                    checked={checked}
                                    onChange={(e) => {
                                      setInviteBranchIds((prev) => {
                                        const next = e.target.checked
                                          ? [...prev, b.id]
                                          : prev.filter((id) => id !== b.id);
                                        if (!e.target.checked && invitePrimaryBranchId === b.id) {
                                          setInvitePrimaryBranchId(null);
                                        }
                                        if (e.target.checked && !invitePrimaryBranchId) {
                                          setInvitePrimaryBranchId(b.id);
                                        }
                                        return next;
                                      });
                                    }}
                                  />
                                  <div className="flex-1 min-w-0">
                                    <p className="text-sm font-medium">{b.name}</p>
                                    {b.code && (
                                      <p className="text-xs text-muted-foreground">{b.code}</p>
                                    )}
                                  </div>
                                  {invitePrimaryBranchId === b.id && (
                                    <Badge variant="secondary">Main branch</Badge>
                                  )}
                                </label>
                              );
                            })}
                          </div>
                        )}
                        <p className="text-xs text-muted-foreground">
                          Branch access is applied automatically when the invitation is accepted.
                        </p>
                      </div>
                    )}

                    {inviteNeedsGroup && (
                      <p className="text-xs text-destructive">
                        Select at least one Access Group. Without one this person would sign in
                        with no access at all.
                      </p>
                    )}
                    {inviteNeedsBranch && (
                      <p className="text-xs text-destructive">
                        Select at least one branch for this branch-limited invitation.
                      </p>
                    )}
                    {inviteAdminBlocked && (
                      <p className="text-xs text-destructive">
                        Only the institution owner can invite an administrator.
                      </p>
                    )}
                    <Button
                      type="submit"
                      className="w-full"
                      disabled={isInviting || inviteInvalid}
                    >
                      {isInviting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      Send Invitation
                    </Button>
                  </form>
                </DialogContent>
              </Dialog>
            </>
          )}
        </div>

        {/* Internal Users */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Shield className="h-5 w-5" />
              Internal Users
            </CardTitle>
            <CardDescription>
              {members.filter(m => m.user_type !== "portal").length} internal user{members.filter(m => m.user_type !== "portal").length !== 1 ? "s" : ""} with access to business applications
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="table-container">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Member</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Branch Access</TableHead>
                  {canManageTeam && <TableHead className="text-right">Actions</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {members.filter(m => m.user_type !== "portal").map((member) => {
                  const isCurrentUser = member.user_id === user?.id;
                  const canManageThis = canManageMember(member);
                  const isAdminOrOwner = member.role === "admin" || member.role === "owner";
                  const memberBranchAssignments = assignmentsByUser[member.user_id] || [];

                  return (
                    <TableRow key={member.id}>
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <Avatar className="h-8 w-8">
                            <AvatarFallback className="text-xs">
                              {member.email.slice(0, 2).toUpperCase()}
                            </AvatarFallback>
                          </Avatar>
                          <div>
                            <p className="font-medium flex items-center gap-2">
                              {member.full_name || member.email}
                              {isCurrentUser && (
                                <Badge variant="outline" className="text-xs">You</Badge>
                              )}
                            </p>
                            {member.full_name && (
                              <p className="text-sm text-muted-foreground">
                                {member.email}
                              </p>
                            )}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        {canManageThis ? (
                          <Select
                            value={member.role}
                            disabled={inlineRoleUpdatingId === member.id}
                            onValueChange={async (newRole) => {
                              if (newRole === member.role) return;
                              if (!canManage(newRole as AppRole)) {
                                toast({
                                  title: "Not allowed",
                                  description: `You cannot assign the ${ROLE_LABELS[newRole as AppRole]} role.`,
                                  variant: "destructive",
                                });
                                return;
                              }
                              setInlineRoleUpdatingId(member.id);
                              try {
                                // Capture previous role for the audit log.
                                setMemberToEdit({ ...member });
                                await handleUpdateRole(member.id, newRole as AppRole);
                              } catch {
                                /* toast already shown */
                              } finally {
                                setInlineRoleUpdatingId(null);
                                setMemberToEdit(null);
                              }
                            }}
                          >
                            <SelectTrigger className="h-8 w-[170px]">
                              <SelectValue>
                                <Badge
                                  variant="secondary"
                                  className={roleColors[member.role]}
                                >
                                  {ROLE_LABELS[member.role]}
                                </Badge>
                              </SelectValue>
                            </SelectTrigger>
                            <SelectContent>
                              {(Object.keys(ROLE_LABELS) as AppRole[])
                                .filter((r) => !LEGACY_ROLES.includes(r))
                                .filter((r) => r !== "portal" && r !== "super_admin" && r !== "owner")
                                .filter((r) => canManage(r))
                                .map((r) => (
                                  <SelectItem key={r} value={r}>
                                    {ROLE_LABELS[r]}
                                  </SelectItem>
                                ))}
                            </SelectContent>

                          </Select>
                        ) : (
                          <Badge
                            variant="secondary"
                            className={roleColors[member.role]}
                          >
                            {ROLE_LABELS[member.role]}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        {isAdminOrOwner ? (
                          <Badge variant="outline" className="text-xs gap-1">
                            <Shield className="h-3 w-3" />
                            All branches
                          </Badge>
                        ) : memberBranchAssignments.length > 0 ? (
                          <div className="flex flex-wrap gap-1">
                            {memberBranchAssignments.slice(0, 2).map((a) => (
                              <Badge
                                key={a.id}
                                variant={a.is_primary ? "default" : "outline"}
                                className="text-xs gap-1"
                              >
                                <MapPin className="h-3 w-3" />
                                {a.branch?.name || "Unknown"}
                                {a.can_manage && <Shield className="h-2.5 w-2.5" />}
                              </Badge>
                            ))}
                            {memberBranchAssignments.length > 2 && (
                              <Badge variant="outline" className="text-xs">
                                +{memberBranchAssignments.length - 2} more
                              </Badge>
                            )}
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            No branches assigned
                          </span>
                        )}
                      </TableCell>
                      {canManageTeam && (
                        <TableCell className="text-right">
                          {canManageThis ? (
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button variant="ghost" size="icon">
                                  <MoreHorizontal className="h-4 w-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem
                                  onClick={() => {
                                    setMemberToEdit(member);
                                    setShowEditRoleDialog(true);
                                  }}
                                >
                                  <Pencil className="mr-2 h-4 w-4" />
                                  Edit Role
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onClick={() => {
                                    setMemberForBranch(member);
                                    setShowBranchDialog(true);
                                  }}
                                >
                                  <MapPin className="mr-2 h-4 w-4" />
                                   Branch Access
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onClick={() => {
                                    setMemberForBusinessAccess(member);
                                    setShowBusinessAccessDialog(true);
                                  }}
                                >
                                  <Building2 className="mr-2 h-4 w-4" />
                                  Business Access
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onClick={() => {
                                    setMemberForGroup(member);
                                    setShowAssignGroupDialog(true);
                                  }}
                                >
                                  <Users className="mr-2 h-4 w-4" />
                                  Access Group
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  className="text-destructive focus:text-destructive"
                                  onClick={() => {
                                    setMemberToRemove(member);
                                    setShowRemoveMemberDialog(true);
                                  }}
                                >
                                  <UserMinus className="mr-2 h-4 w-4" />
                                  Remove Member
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          ) : (
                            isCurrentUser ? (
                              <span className="text-xs text-muted-foreground">—</span>
                            ) : (
                              <Shield className="h-4 w-4 text-muted-foreground ml-auto" />
                            )
                          )}
                        </TableCell>
                      )}
                    </TableRow>
                  );
                })}
                {members.filter(m => m.user_type !== "portal").length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center text-muted-foreground py-8">
                      No internal users found.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
            </div>
          </CardContent>
        </Card>

        {/* Portal Users */}
        {members.filter(m => m.user_type === "portal").length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <ArrowUpRight className="h-5 w-5" />
                Portal Users
              </CardTitle>
              <CardDescription>
                {members.filter(m => m.user_type === "portal").length} portal user{members.filter(m => m.user_type === "portal").length !== 1 ? "s" : ""} with self-service access only (leave, timesheets, profile). Promote to internal to grant business app access.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="table-container">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Member</TableHead>
                    <TableHead>Access</TableHead>
                    {canManageTeam && <TableHead className="text-right">Actions</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {members.filter(m => m.user_type === "portal").map((member) => {
                    const canManageThis = canManageMember(member);

                    return (
                      <TableRow key={member.id}>
                        <TableCell>
                          <div className="flex items-center gap-3">
                            <Avatar className="h-8 w-8">
                              <AvatarFallback className="text-xs">
                                {member.email.slice(0, 2).toUpperCase()}
                              </AvatarFallback>
                            </Avatar>
                            <div>
                              <p className="font-medium">
                                {member.full_name || member.email}
                              </p>
                              {member.full_name && (
                                <p className="text-sm text-muted-foreground">
                                  {member.email}
                                </p>
                              )}
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-xs bg-teal-500/5 text-teal-600 border-teal-200 dark:text-teal-400 dark:border-teal-800">
                            Self-service Portal
                          </Badge>
                        </TableCell>
                        {canManageTeam && (
                          <TableCell className="text-right">
                            {canManageThis ? (
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button variant="ghost" size="icon">
                                    <MoreHorizontal className="h-4 w-4" />
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                  <DropdownMenuItem
                                    onClick={() => {
                                      setMemberToPromote(member);
                                      setShowPromoteDialog(true);
                                    }}
                                  >
                                    <ArrowUpRight className="mr-2 h-4 w-4" />
                                    Promote to Internal
                                  </DropdownMenuItem>
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem
                                    className="text-destructive focus:text-destructive"
                                    onClick={() => {
                                      setMemberToRemove(member);
                                      setShowRemoveMemberDialog(true);
                                    }}
                                  >
                                    <UserMinus className="mr-2 h-4 w-4" />
                                    Remove Member
                                  </DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            ) : (
                              <Shield className="h-4 w-4 text-muted-foreground ml-auto" />
                            )}
                          </TableCell>
                        )}
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Pending Invitations */}
        {invitations.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Clock className="h-5 w-5" />
                Pending Invitations
              </CardTitle>
              <CardDescription>
                Invitations waiting to be accepted
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="table-container">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Email</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Expires</TableHead>
                    {canManageTeam && <TableHead className="text-right">Actions</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {invitations.map((invite) => (
                    <TableRow key={invite.id}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Mail className="h-4 w-4 text-muted-foreground" />
                          {invite.email}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="secondary"
                          className={roleColors[invite.role]}
                        >
                          {ROLE_LABELS[invite.role]}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {new Date(invite.expires_at).toLocaleDateString()}
                      </TableCell>
                      {canManageTeam && (
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                handleResendInvitation(invite.id, invite.email, invite.token);
                              }}
                              disabled={resendingId === invite.id || revokingId === invite.id}
                            >
                              {resendingId === invite.id ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <>
                                  <RefreshCw className="mr-1 h-4 w-4" />
                                  Resend
                                </>
                              )}
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                void copyInvitationLink(buildInvitationAcceptUrl(invite.token)).then(
                                  () => toast({ title: "Invitation link copied" }),
                                  () => toast({ title: "Copy failed", variant: "destructive" }),
                                );
                              }}
                              disabled={!invite.token || resendingId === invite.id || revokingId === invite.id}
                            >
                              <Copy className="mr-1 h-4 w-4" />
                              Copy link
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-destructive hover:text-destructive hover:bg-destructive/10"
                              onClick={() => {
                                setInvitationToRevoke(invite);
                                setShowRevokeDialog(true);
                              }}
                              disabled={resendingId === invite.id || revokingId === invite.id}
                            >
                              {revokingId === invite.id ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <>
                                  <Trash2 className="mr-1 h-4 w-4" />
                                  Revoke
                                </>
                              )}
                            </Button>
                          </div>
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Duplicate Invitation Dialog */}
      <AlertDialog open={showDuplicateDialog} onOpenChange={setShowDuplicateDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Invitation Already Exists</AlertDialogTitle>
            <AlertDialogDescription>
              A pending invitation for <strong>{existingInvitation?.email}</strong> already exists.
              Would you like to resend the invitation email instead?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => {
              setExistingInvitation(null);
              setShowDuplicateDialog(false);
            }}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction onClick={handleResendFromDuplicateDialog}>
              Resend Invitation
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Revoke Confirmation Dialog */}
      <AlertDialog open={showRevokeDialog} onOpenChange={setShowRevokeDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke invitation?</AlertDialogTitle>
            <AlertDialogDescription>
              This will immediately invalidate the invitation link for <strong>{invitationToRevoke?.email}</strong>.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => {
              setInvitationToRevoke(null);
              setShowRevokeDialog(false);
            }}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                if (!invitationToRevoke) return;
                const { id, email } = invitationToRevoke;
                setShowRevokeDialog(false);
                setInvitationToRevoke(null);
                await handleRevokeInvitation(id, email);
              }}
            >
              Revoke
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Edit Role Dialog */}
      <EditRoleDialog
        open={showEditRoleDialog}
        onOpenChange={(open) => {
          setShowEditRoleDialog(open);
          if (!open) setMemberToEdit(null);
        }}
        member={memberToEdit}
        onConfirm={handleUpdateRole}
      />

      {/* Remove Member Dialog */}
      <RemoveMemberDialog
        open={showRemoveMemberDialog}
        onOpenChange={(open) => {
          setShowRemoveMemberDialog(open);
          if (!open) setMemberToRemove(null);
        }}
        member={memberToRemove}
        onConfirm={handleRemoveMember}
      />

      {/* Branch Assignment Dialog */}
      <BranchAssignmentDialog
        open={showBranchDialog}
        onOpenChange={(open) => {
          setShowBranchDialog(open);
          if (!open) {
            setMemberForBranch(null);
            refetchAll();
          }
        }}
        member={memberForBranch}
        existingAssignments={memberForBranch ? assignmentsByUser[memberForBranch.user_id] || [] : []}
      />

      {/* Promote to Internal Dialog */}
      <PromoteToInternalDialog
        open={showPromoteDialog}
        onOpenChange={(open) => {
          setShowPromoteDialog(open);
          if (!open) setMemberToPromote(null);
        }}
        member={memberToPromote}
        onConfirm={handlePromoteToInternal}
      />

      {/* Assign Group Dialog */}
      <AssignGroupDialog
        open={showAssignGroupDialog}
        onOpenChange={(open) => {
          setShowAssignGroupDialog(open);
          if (!open) setMemberForGroup(null);
        }}
        member={memberForGroup}
      />

      {/* Business Access Dialog */}
      <BusinessAccessDialog
        open={showBusinessAccessDialog}
        onOpenChange={(open) => {
          setShowBusinessAccessDialog(open);
          if (!open) setMemberForBusinessAccess(null);
        }}
        member={memberForBusinessAccess}
      />
    </PlatformAppLayout>
  );
}
