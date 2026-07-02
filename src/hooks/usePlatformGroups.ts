import { useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";

export interface PlatformGroup {
  id: string;
  name: string;
  description: string | null;
  is_system: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  permissions: string[];
  member_count: number;
}

export function usePlatformGroups() {
  const { user } = useAuth();
  const [groups, setGroups] = useState<PlatformGroup[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const fetchGroups = useCallback(async () => {
    setIsLoading(true);
    try {
      const { data: groupData, error } = await supabase
        .from("platform_admin_groups")
        .select("*")
        .order("is_system", { ascending: false })
        .order("name");

      if (error) throw error;

      const groupIds = (groupData || []).map((g: any) => g.id);

      // Fetch permissions and member counts in parallel
      const [permRes, memberRes] = await Promise.all([
        supabase.from("platform_admin_group_permissions")
          .select("group_id, permission_key")
          .in("group_id", groupIds),
        supabase.from("platform_admin_group_members")
          .select("group_id")
          .in("group_id", groupIds),
      ]);

      const permMap = new Map<string, string[]>();
      (permRes.data || []).forEach((p: any) => {
        const perms = permMap.get(p.group_id) || [];
        perms.push(p.permission_key);
        permMap.set(p.group_id, perms);
      });

      const countMap = new Map<string, number>();
      (memberRes.data || []).forEach((m: any) => {
        countMap.set(m.group_id, (countMap.get(m.group_id) || 0) + 1);
      });

      const enriched: PlatformGroup[] = (groupData || []).map((g: any) => ({
        ...g,
        permissions: permMap.get(g.id) || [],
        member_count: countMap.get(g.id) || 0,
      }));

      setGroups(enriched);
    } catch (err: any) {
      console.error("Error fetching platform groups:", err);
      toast.error("Failed to load groups");
    } finally {
      setIsLoading(false);
    }
  }, []);

  const createGroup = useCallback(async (
    name: string,
    description: string,
    permissionKeys: string[],
  ) => {
    if (!user) return;
    try {
      const { data: newGroup, error } = await supabase
        .from("platform_admin_groups")
        .insert({
          name,
          description,
          is_system: false,
          created_by: user.id,
        })
        .select("id")
        .single();

      if (error) throw error;

      if (newGroup && permissionKeys.length > 0) {
        const rows = permissionKeys.map(key => ({
          group_id: newGroup.id,
          permission_key: key,
        }));
        await supabase.from("platform_admin_group_permissions").insert(rows);
      }

      toast.success(`Group "${name}" created`);
      await fetchGroups();
    } catch (err: any) {
      toast.error(normalizeError(err).message || "Failed to create group");
    }
  }, [user, fetchGroups]);

  const updateGroup = useCallback(async (
    groupId: string,
    name: string,
    description: string,
    permissionKeys: string[],
  ) => {
    try {
      await supabase
        .from("platform_admin_groups")
        .update({ name, description, updated_at: new Date().toISOString() })
        .eq("id", groupId);

      // Replace permissions
      await supabase
        .from("platform_admin_group_permissions")
        .delete()
        .eq("group_id", groupId);

      if (permissionKeys.length > 0) {
        const rows = permissionKeys.map(key => ({
          group_id: groupId,
          permission_key: key,
        }));
        await supabase.from("platform_admin_group_permissions").insert(rows);
      }

      toast.success("Group updated");
      await fetchGroups();
    } catch (err: any) {
      toast.error("Failed to update group");
    }
  }, [fetchGroups]);

  const deleteGroup = useCallback(async (groupId: string) => {
    try {
      const { error } = await supabase
        .from("platform_admin_groups")
        .delete()
        .eq("id", groupId)
        .eq("is_system", false); // Safety: cannot delete system groups

      if (error) throw error;

      toast.success("Group deleted");
      await fetchGroups();
    } catch (err: any) {
      toast.error("Failed to delete group");
    }
  }, [fetchGroups]);

  return {
    groups,
    isLoading,
    fetchGroups,
    createGroup,
    updateGroup,
    deleteGroup,
  };
}
