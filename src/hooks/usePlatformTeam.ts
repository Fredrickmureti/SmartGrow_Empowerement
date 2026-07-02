import { useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";
import type { PlatformAdminRole } from "./usePlatformPermissions";
import { normalizeError } from "@/services/resilience";

export interface PlatformAdmin {
  id: string;
  user_id: string;
  role: PlatformAdminRole;
  is_active: boolean;
  granted_at: string;
  granted_by: string | null;
  invited_email: string | null;
  invited_at: string | null;
  accepted_at: string | null;
  deactivated_at: string | null;
  deactivated_by: string | null;
  notes: string | null;
  // Joined profile data
  email?: string;
  full_name?: string;
  avatar_url?: string;
  // Group memberships
  groups?: { id: string; name: string }[];
}

export interface PlatformInvitation {
  id: string;
  email: string;
  role: string;
  status: string;
  invited_by: string;
  expires_at: string;
  created_at: string;
  group_ids: string[];
  country_codes: string[];
}

export function usePlatformTeam() {
  const { user } = useAuth();
  const [admins, setAdmins] = useState<PlatformAdmin[]>([]);
  const [invitations, setInvitations] = useState<PlatformInvitation[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const fetchTeam = useCallback(async () => {
    setIsLoading(true);
    try {
      // Fetch all platform admins
      const { data: adminData, error } = await supabase
        .from("platform_admins")
        .select("*")
        .order("granted_at", { ascending: true });

      if (error) throw error;

      // Fetch profiles for all admin user_ids.
      // IMPORTANT: profiles.id is the profile row PK, NOT the auth user id.
      // The auth user id lives in profiles.user_id, so we must filter on that.
      const userIds = (adminData || []).map((a: any) => a.user_id).filter(Boolean);
      const { data: profiles } = userIds.length
        ? await supabase
            .from("profiles")
            .select("user_id, email, full_name, avatar_url")
            .in("user_id", userIds)
        : { data: [] as any[] };

      // Fetch group memberships
      const adminIds = (adminData || []).map((a: any) => a.id);
      const { data: memberships } = await supabase
        .from("platform_admin_group_members")
        .select("admin_id, group_id, platform_admin_groups(id, name)")
        .in("admin_id", adminIds);

      // Fetch pending invitations
      const { data: inviteData } = await supabase
        .from("platform_admin_invitations")
        .select("*")
        .eq("status", "pending")
        .order("created_at", { ascending: false });

      setInvitations((inviteData || []) as PlatformInvitation[]);

      const profileMap = new Map((profiles || []).map((p: any) => [p.user_id, p]));
      const membershipMap = new Map<string, { id: string; name: string }[]>();
      (memberships || []).forEach((m: any) => {
        const groups = membershipMap.get(m.admin_id) || [];
        if (m.platform_admin_groups) {
          groups.push({ id: m.platform_admin_groups.id, name: m.platform_admin_groups.name });
        }
        membershipMap.set(m.admin_id, groups);
      });

      const enriched: PlatformAdmin[] = (adminData || []).map((a: any) => {
        const profile = profileMap.get(a.user_id) as any;
        return {
          ...a,
          email: profile?.email || a.invited_email || "Unknown",
          full_name: profile?.full_name || "",
          avatar_url: profile?.avatar_url || "",
          groups: membershipMap.get(a.id) || [],
        };
      });

      setAdmins(enriched);
    } catch (err: any) {
      console.error("Error fetching platform team:", err);
      toast.error("Failed to load platform team");
    } finally {
      setIsLoading(false);
    }
  }, []);

  const inviteAdmin = useCallback(async (
    email: string,
    role: "admin" | "operator",
    groupIds: string[],
    countryCodes: string[] = [],
    notes?: string,
  ) => {
    if (!user) return;

    try {
      const { data, error } = await supabase.functions.invoke("invite-platform-admin", {
        body: {
          action: "invite",
          email,
          role,
          groupIds,
          countryCodes,
          notes,
        },
      });

      if (error) throw error;
      if (data?.error) throw new Error(data.error);

      toast.success(data.message || `Invitation sent to ${email}`);
      await fetchTeam();
    } catch (err: any) {
      console.error("Error inviting admin:", err);
      toast.error(normalizeError(err).message || "Failed to invite admin");
    }
  }, [user, fetchTeam]);

  const cancelInvitation = useCallback(async (invitationId: string) => {
    try {
      const { data, error } = await supabase.functions.invoke("invite-platform-admin", {
        body: { action: "cancel", invitationId },
      });
      if (error) throw error;
      toast.success("Invitation cancelled");
      await fetchTeam();
    } catch (err: any) {
      toast.error("Failed to cancel invitation");
    }
  }, [fetchTeam]);

  const resendInvitation = useCallback(async (invitationId: string) => {
    try {
      const { data, error } = await supabase.functions.invoke("invite-platform-admin", {
        body: { action: "resend", invitationId },
      });
      if (error) throw error;
      toast.success("Invitation renewed");
      await fetchTeam();
    } catch (err: any) {
      toast.error("Failed to resend invitation");
    }
  }, [fetchTeam]);

  const deactivateAdmin = useCallback(async (adminId: string) => {
    if (!user) return;
    try {
      const { error } = await supabase
        .from("platform_admins")
        .update({
          is_active: false,
          deactivated_at: new Date().toISOString(),
          deactivated_by: user.id,
        })
        .eq("id", adminId);

      if (error) throw error;

      await supabase.from("admin_audit_log").insert({
        admin_user_id: user.id,
        action_type: "platform_admin_deactivated",
        details: { deactivated_admin_id: adminId },
        user_agent: navigator.userAgent,
      });

      toast.success("Admin deactivated");
      await fetchTeam();
    } catch (err: any) {
      toast.error("Failed to deactivate admin");
    }
  }, [user, fetchTeam]);

  const reactivateAdmin = useCallback(async (adminId: string) => {
    if (!user) return;
    try {
      const { error } = await supabase
        .from("platform_admins")
        .update({
          is_active: true,
          deactivated_at: null,
          deactivated_by: null,
        })
        .eq("id", adminId);

      if (error) throw error;

      await supabase.from("admin_audit_log").insert({
        admin_user_id: user.id,
        action_type: "platform_admin_reactivated",
        details: { admin_id: adminId },
        user_agent: navigator.userAgent,
      });

      toast.success("Admin reactivated");
      await fetchTeam();
    } catch (err: any) {
      toast.error("Failed to reactivate admin");
    }
  }, [user, fetchTeam]);

  const updateAdminRole = useCallback(async (adminId: string, newRole: "admin" | "operator") => {
    if (!user) return;
    try {
      const { error } = await supabase
        .from("platform_admins")
        .update({ role: newRole })
        .eq("id", adminId);

      if (error) throw error;

      await supabase.from("admin_audit_log").insert({
        admin_user_id: user.id,
        action_type: "platform_admin_role_changed",
        details: { admin_id: adminId, new_role: newRole },
        user_agent: navigator.userAgent,
      });

      toast.success("Role updated");
      await fetchTeam();
    } catch (err: any) {
      toast.error("Failed to update role");
    }
  }, [user, fetchTeam]);

  const updateAdminGroups = useCallback(async (adminId: string, groupIds: string[]) => {
    if (!user) return;
    try {
      // Check guardrails for each group assignment
      for (const gId of groupIds) {
        const { data: check, error: checkErr } = await supabase.rpc(
          "check_group_assignment_allowed",
          { _assigner_id: user.id, _target_admin_id: adminId, _group_id: gId }
        );
        if (checkErr) throw checkErr;
        const result = check as any;
        if (!result?.allowed) {
          toast.error(result?.reason || "Group assignment not allowed");
          return;
        }
      }

      // Remove all current memberships
      await supabase
        .from("platform_admin_group_members")
        .delete()
        .eq("admin_id", adminId);

      // Add new memberships
      if (groupIds.length > 0) {
        const rows = groupIds.map(gId => ({
          admin_id: adminId,
          group_id: gId,
          assigned_by: user.id,
        }));
        await supabase.from("platform_admin_group_members").insert(rows);
      }

      // Audit log
      await supabase.from("admin_audit_log").insert({
        admin_user_id: user.id,
        action_type: "platform_admin_groups_changed",
        details: { admin_id: adminId, group_ids: groupIds },
        user_agent: navigator.userAgent,
      });

      toast.success("Groups updated");
      await fetchTeam();
    } catch (err: any) {
      toast.error("Failed to update groups");
    }
  }, [user, fetchTeam]);

  return {
    admins,
    invitations,
    isLoading,
    fetchTeam,
    inviteAdmin,
    cancelInvitation,
    resendInvitation,
    deactivateAdmin,
    reactivateAdmin,
    updateAdminRole,
    updateAdminGroups,
  };
}
