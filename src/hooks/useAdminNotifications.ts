import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";

export interface AdminNotification {
  id: string;
  admin_user_id: string;
  type: string;
  category: string;
  title: string;
  message: string;
  link: string | null;
  metadata: Record<string, unknown> | null;
  is_read: boolean;
  is_dismissed: boolean;
  priority: number;
  created_at: string;
}

export function useAdminNotifications() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const { data: notifications = [], isLoading } = useQuery({
    queryKey: ["admin-notifications", user?.id],
    queryFn: async () => {
      const { data, error } = await (supabase.from as any)("platform_admin_notifications")
        .select("*")
        .eq("admin_user_id", user!.id)
        .eq("is_dismissed", false)
        .order("created_at", { ascending: false })
        .limit(50);

      if (error) throw error;
      return (data || []) as AdminNotification[];
    },
    enabled: !!user?.id,
    refetchInterval: 30000, // Poll every 30s
  });

  const unreadCount = notifications.filter((n) => !n.is_read).length;

  const markAsRead = useMutation({
    mutationFn: async (notificationId: string) => {
      const { error } = await (supabase.from as any)("platform_admin_notifications")
        .update({ is_read: true })
        .eq("id", notificationId);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-notifications"] }),
  });

  const markAllAsRead = useMutation({
    mutationFn: async () => {
      const { error } = await (supabase.from as any)("platform_admin_notifications")
        .update({ is_read: true })
        .eq("admin_user_id", user!.id)
        .eq("is_read", false);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-notifications"] }),
  });

  const dismiss = useMutation({
    mutationFn: async (notificationId: string) => {
      const { error } = await (supabase.from as any)("platform_admin_notifications")
        .update({ is_dismissed: true })
        .eq("id", notificationId);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-notifications"] }),
  });

  const dismissAll = useMutation({
    mutationFn: async () => {
      const { error } = await (supabase.from as any)("platform_admin_notifications")
        .update({ is_dismissed: true })
        .eq("admin_user_id", user!.id);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-notifications"] }),
  });

  return {
    notifications,
    unreadCount,
    isLoading,
    markAsRead,
    markAllAsRead,
    dismiss,
    dismissAll,
  };
}
