import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { toast } from "sonner";
import type { Database } from "@/integrations/supabase/types";
import { normalizeError } from "@/services/resilience";

type SmsEventType = Database["public"]["Enums"]["sms_event_type"];
type SmsRecipientType = Database["public"]["Enums"]["sms_recipient_type"];

export interface SmsEventRule {
  id: string;
  organization_id: string;
  event_type: SmsEventType;
  is_enabled: boolean;
  template_id: string | null;
  recipient_type: SmsRecipientType;
  created_at: string;
}

/**
 * SMS event rules are workspace-scoped (matching the post-RBAC convention):
 * `business_id` stays NULL and there is a UNIQUE (organization_id, event_type)
 * index in the database. Reading and writing must therefore not filter by
 * business_id — doing so was the cause of the "toggle does nothing in the UI"
 * bug because the read returned [] while the write succeeded silently.
 */
export function useSmsEventRules() {
  const { currentOrg } = useOrganization();
  const queryClient = useQueryClient();
  const orgId = currentOrg?.id;

  const rulesQuery = useQuery({
    queryKey: ["sms-event-rules", orgId],
    queryFn: async () => {
      if (!orgId) return [];
      const { data, error } = await supabase
        .from("sms_event_rules")
        .select("*")
        .eq("organization_id", orgId)
        .order("event_type");
      if (error) throw error;
      return (data || []) as SmsEventRule[];
    },
    enabled: !!orgId,
  });

  const upsertRule = useMutation({
    mutationFn: async (rule: {
      event_type: SmsEventType;
      is_enabled?: boolean;
      template_id?: string | null;
      recipient_type?: SmsRecipientType;
    }) => {
      if (!orgId) throw new Error("No organization");

      // True upsert against the (organization_id, event_type) unique index so
      // we can never end up with duplicate rule rows even under concurrent
      // toggles or stale read caches.
      const existing = rulesQuery.data?.find((r) => r.event_type === rule.event_type);
      const payload: Record<string, unknown> = {
        organization_id: orgId,
        event_type: rule.event_type,
        is_enabled: rule.is_enabled ?? existing?.is_enabled ?? false,
        recipient_type: rule.recipient_type ?? existing?.recipient_type ?? "customer",
      };
      if ("template_id" in rule) payload.template_id = rule.template_id;
      else if (existing) payload.template_id = existing.template_id;

      const { error } = await (supabase as any)
        .from("sms_event_rules")
        .upsert(payload, { onConflict: "organization_id,event_type" });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sms-event-rules", orgId] });
      toast.success("Rule updated");
    },
    onError: (err: Error) => toast.error(normalizeError(err).message),
  });

  return {
    rules: rulesQuery.data || [],
    isLoading: rulesQuery.isLoading,
    upsertRule,
  };
}
