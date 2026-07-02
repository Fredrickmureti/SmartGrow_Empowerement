/**
 * useAppAccessRequest — file an access request to the tenant admin
 * for an app the org has installed but the current user lacks RBAC for.
 *
 * Backed by SECURITY DEFINER RPC `request_app_access(app_id, message)`
 * which writes to public.approval_requests with type 'app_access'.
 */
import { useMutation } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export function useAppAccessRequest() {
  const m = useMutation({
    mutationFn: async (args: { appId: string; message?: string }) => {
      const { data, error } = await (supabase as any).rpc(
        "request_app_access",
        { _app_id: args.appId, _message: args.message ?? null },
      );
      if (error) throw error;
      return data as string;
    },
    onSuccess: () => {
      toast.success("Request sent to your administrator.");
    },
    onError: (err: unknown) => {
      toast.error(
        `Couldn't send request: ${(err as Error)?.message ?? "unknown error"}`,
      );
    },
  });

  return {
    requestAccess: (appId: string, message?: string) =>
      m.mutateAsync({ appId, message }),
    isSubmitting: m.isPending,
  };
}
