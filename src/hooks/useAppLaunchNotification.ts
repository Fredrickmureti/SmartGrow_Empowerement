/**
 * useAppLaunchNotification — write-side helper for the marketplace
 * "Notify me when [App] launches" CTA on coming-soon apps.
 *
 * Backed by the SECURITY DEFINER RPC `notify_me_when_app_launches`,
 * which writes to public.app_launch_notifications and is idempotent
 * per (user, org, app).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useSession } from "@/contexts/SessionContext";
import { toast } from "sonner";

export function useAppLaunchNotification(appId: string) {
  const { sessionData, currentOrg } = useSession();
  const userId = sessionData?.user_id ?? null;
  const qc = useQueryClient();

  const { data: alreadyNotified = false } = useQuery({
    queryKey: ["app-launch-notification", appId, currentOrg?.id, userId],
    queryFn: async () => {
      if (!userId) return false;
      const { data, error } = await (supabase as any)
        .from("app_launch_notifications")
        .select("id")
        .eq("user_id", userId)
        .eq("app_id", appId)
        .limit(1);
      if (error) return false;
      return Array.isArray(data) && data.length > 0;
    },
    enabled: !!userId,
    staleTime: 60_000,
  });

  const notifyMutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await (supabase as any).rpc(
        "notify_me_when_app_launches",
        { _app_id: appId },
      );
      if (error) throw error;
      return data as string;
    },
    onSuccess: () => {
      toast.success("We'll email you the day this app ships.");
      qc.invalidateQueries({
        queryKey: ["app-launch-notification", appId],
      });
    },
    onError: (err: unknown) => {
      toast.error(
        `Couldn't register: ${(err as Error)?.message ?? "unknown error"}`,
      );
    },
  });

  return {
    alreadyNotified,
    notifyMe: () => notifyMutation.mutateAsync(),
    isSubmitting: notifyMutation.isPending,
  };
}
