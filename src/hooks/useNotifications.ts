import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useAuth } from "@/contexts/AuthContext";
import { useSession } from "@/contexts/SessionContext";
import { useEffect, useCallback } from "react";
import { toast } from "sonner";

export interface Notification {
  id: string;
  organization_id: string;
  business_id: string | null;
  user_id: string;
  type: 'info' | 'warning' | 'error' | 'success';
  category: string;
  title: string;
  message: string;
  link: string | null;
  entity_type: string | null;
  entity_id: string | null;
  is_read: boolean;
  is_dismissed: boolean;
  priority: number;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface NotificationPreference {
  id: string;
  user_id: string;
  organization_id: string;
  category: string;
  email_enabled: boolean;
  push_enabled: boolean;
  in_app_enabled: boolean;
  sms_enabled?: boolean;
}

const ALL_NOTIFICATION_CATEGORIES = [
  { value: 'invoice', label: 'Invoices' },
  { value: 'payment', label: 'Payments' },
  { value: 'inventory', label: 'Inventory' },
  { value: 'expense', label: 'Expenses' },
  { value: 'team', label: 'Team' },
  { value: 'pos', label: 'Point of Sale' },
  { value: 'system', label: 'System' },
  { value: 'leave', label: 'Leave Requests' },
  { value: 'timesheet', label: 'Timesheets' },
  { value: 'payslip', label: 'Payslips' },
  { value: 'loan', label: 'Loans & Advances' },
  { value: 'talent', label: 'Talent (goals, reviews, development)' },
];

// Categories portal users are allowed to see (self-service relevant only)
const PORTAL_ALLOWED_CATEGORIES = ['system', 'leave', 'timesheet', 'payslip', 'loan', 'talent'];

// Re-export a computed version for components
const NOTIFICATION_CATEGORIES = ALL_NOTIFICATION_CATEGORIES;

interface UseNotificationsOptions {
  skipRealtime?: boolean;
}

export function useNotifications(options: UseNotificationsOptions = {}) {
  const { skipRealtime = false } = options;
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { user } = useAuth();
  const { userType } = useSession();
  const queryClient = useQueryClient();

  const organizationId = currentOrg?.id;
  const businessId = currentBusiness?.id;
  const userId = user?.id;
  const isPortalUser = userType === "portal";

  // Fetch notifications
  const { data: notifications = [], isLoading, refetch } = useQuery({
    queryKey: ["notifications", organizationId, businessId, userId],
    queryFn: async () => {
      if (!organizationId || !userId) return [];

      let query = supabase
        // SCOPE-EXEMPT: `notifications` is workspace-wide (no business_id column)
        .from("notifications")
        .select("*")
        .eq("user_id", userId)
        .eq("is_dismissed", false)
        .order("created_at", { ascending: false })
        .limit(50);

      // Optionally filter by business
      if (businessId) {
        query = query.or(`business_id.eq.${businessId},business_id.is.null`);
      }

      // Portal users: filter to only relevant categories
      if (isPortalUser) {
        query = query.in("category", PORTAL_ALLOWED_CATEGORIES);
      }

      const { data, error } = await query;
      if (error) throw error;
      return data as Notification[];
    },
    enabled: !!organizationId && !!userId,
  });

  // Calculate unread count
  const unreadCount = notifications.filter(n => !n.is_read).length;

  // Fetch notification preferences
  const { data: preferences = [] } = useQuery({
    queryKey: ["notification-preferences", organizationId, businessId, userId],
    queryFn: async () => {
      if (!organizationId || !userId || !businessId) return [];

      // business_id is NOT NULL on notification_preferences. We must NOT pass
      // undefined into the URL — that produced "business_id=eq.undefined" → 400.
      const { data, error } = await supabase
        .from("notification_preferences")
        .select("*")
        .eq("user_id", userId)
        .eq("organization_id", organizationId)
        .eq("business_id", businessId);

      if (error) throw error;
      return data as NotificationPreference[];
    },
    enabled: !!organizationId && !!userId && !!businessId,
  });

  // Real-time subscription for notifications (INSERT, UPDATE, DELETE)
  useEffect(() => {
    if (!userId || skipRealtime) return;

    const channel = supabase
      .channel(`notifications-realtime-${userId}-${Math.random().toString(36).slice(2, 10)}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'notifications',
          filter: `user_id=eq.${userId}`,
        },
        (payload) => {
          const newNotification = payload.new as Notification;
          
          // Show toast for new notification
          toast(newNotification.title, {
            description: newNotification.message,
            action: newNotification.link ? {
              label: 'View',
              onClick: () => window.location.href = newNotification.link!,
            } : undefined,
          });

          // Optimistically add to cache
          queryClient.setQueryData(
            ["notifications", organizationId, businessId, userId],
            (oldData: Notification[] | undefined) => {
              if (!oldData) return [newNotification];
              return [newNotification, ...oldData];
            }
          );
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'notifications',
          filter: `user_id=eq.${userId}`,
        },
        (payload) => {
          const updatedNotification = payload.new as Notification;
          
          // Optimistically update in cache
          queryClient.setQueryData(
            ["notifications", organizationId, businessId, userId],
            (oldData: Notification[] | undefined) => {
              if (!oldData) return oldData;
              
              // If dismissed, remove from list
              if (updatedNotification.is_dismissed) {
                return oldData.filter((n) => n.id !== updatedNotification.id);
              }
              
              // Otherwise update the notification
              return oldData.map((n) =>
                n.id === updatedNotification.id ? updatedNotification : n
              );
            }
          );
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'DELETE',
          schema: 'public',
          table: 'notifications',
          filter: `user_id=eq.${userId}`,
        },
        (payload) => {
          const deletedId = payload.old?.id;
          
          // Remove from cache
          queryClient.setQueryData(
            ["notifications", organizationId, businessId, userId],
            (oldData: Notification[] | undefined) => {
              if (!oldData) return oldData;
              return oldData.filter((n) => n.id !== deletedId);
            }
          );
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [userId, organizationId, businessId, queryClient]);

  // Mark as read mutation
  const markAsReadMutation = useMutation({
    mutationFn: async (notificationId: string) => {
      const { error } = await supabase
        .from("notifications")
        .update({ is_read: true })
        .eq("id", notificationId);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["notifications"] });
    },
  });

  // Mark all as read mutation
  const markAllAsReadMutation = useMutation({
    mutationFn: async () => {
      if (!userId) return;

      const { error } = await supabase
        .from("notifications")
        .update({ is_read: true })
        .eq("user_id", userId)
        .eq("is_read", false);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["notifications"] });
      toast.success("All notifications marked as read");
    },
  });

  // Dismiss notification mutation
  const dismissMutation = useMutation({
    mutationFn: async (notificationId: string) => {
      const { error } = await supabase
        .from("notifications")
        .update({ is_dismissed: true })
        .eq("id", notificationId);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["notifications"] });
    },
  });

  // Clear all notifications mutation
  const clearAllMutation = useMutation({
    mutationFn: async () => {
      if (!userId) return;

      const { error } = await supabase
        .from("notifications")
        .update({ is_dismissed: true })
        .eq("user_id", userId)
        .eq("is_dismissed", false);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["notifications"] });
      toast.success("All notifications cleared");
    },
  });

  // Update preference mutation
  const updatePreferenceMutation = useMutation({
    mutationFn: async (preference: Partial<NotificationPreference> & { category: string }) => {
      if (!userId || !organizationId || !businessId) {
        throw new Error("Select a Company before updating notification preferences");
      }

      const { error } = await supabase
        .from("notification_preferences")
        .upsert({
          user_id: userId,
          organization_id: organizationId,
          business_id: businessId,
          category: preference.category,
          email_enabled: preference.email_enabled ?? true,
          push_enabled: preference.push_enabled ?? true,
          in_app_enabled: preference.in_app_enabled ?? true,
        }, {
          onConflict: 'user_id,organization_id,category',
        });

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["notification-preferences"] });
      toast.success("Notification preferences updated");
    },
  });

  // Get preference for a category
  const getPreference = useCallback((category: string): NotificationPreference | undefined => {
    return preferences.find(p => p.category === category);
  }, [preferences]);

  // Return filtered categories for portal users
  const visibleCategories = isPortalUser
    ? ALL_NOTIFICATION_CATEGORIES.filter(c => PORTAL_ALLOWED_CATEGORIES.includes(c.value))
    : ALL_NOTIFICATION_CATEGORIES;

  return {
    notifications,
    unreadCount,
    isLoading,
    preferences,
    categories: visibleCategories,
    isPortalUser,
    markAsRead: markAsReadMutation.mutate,
    markAllAsRead: markAllAsReadMutation.mutate,
    dismiss: dismissMutation.mutate,
    clearAll: clearAllMutation.mutate,
    updatePreference: updatePreferenceMutation.mutate,
    getPreference,
    refetch,
  };
}

export { NOTIFICATION_CATEGORIES, PORTAL_ALLOWED_CATEGORIES };
