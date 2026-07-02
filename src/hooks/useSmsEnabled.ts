import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";

/**
 * Lightweight hook to check if SMS is configured and enabled for the current org.
 * Use this in other modules to conditionally show "Send SMS" buttons, etc.
 * Returns { smsEnabled, isLoading }.
 */
export function useSmsEnabled() {
  const { currentOrg } = useOrganization();
  const orgId = currentOrg?.id;

  const { data: smsEnabled = false, isLoading } = useQuery({
    queryKey: ["sms-enabled", orgId],
    queryFn: async () => {
      if (!orgId) return false;
      const { data } = await supabase
        .from("sms_provider_configs")
        .select("is_enabled")
        .eq("organization_id", orgId)
        .eq("is_enabled", true)
        .limit(1)
        .maybeSingle();
      return !!data;
    },
    enabled: !!orgId,
    staleTime: 60_000, // cache for 1 minute
  });

  return { smsEnabled, isLoading };
}
