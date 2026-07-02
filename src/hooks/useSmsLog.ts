import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import type { Database } from "@/integrations/supabase/types";

type SmsStatus = Database["public"]["Enums"]["sms_status"];
type SmsEventType = Database["public"]["Enums"]["sms_event_type"];

export interface SmsLogEntry {
  id: string;
  organization_id: string;
  business_id: string | null;
  event_type: SmsEventType | null;
  recipient_phone: string;
  message_body: string;
  status: SmsStatus;
  provider_message_id: string | null;
  error_code: string | null;
  error_message: string | null;
  cost: number | null;
  sent_at: string | null;
  delivered_at: string | null;
  created_at: string;
}

export function useSmsLog(filters?: {
  status?: SmsStatus;
  eventType?: SmsEventType;
  page?: number;
  pageSize?: number;
}) {
  const { currentOrg } = useOrganization();
  const orgId = currentOrg?.id;
  const page = filters?.page || 0;
  const pageSize = filters?.pageSize || 25;

  return useQuery({
    queryKey: ["sms-log", orgId, filters],
    queryFn: async () => {
      if (!orgId) return { data: [], count: 0 };

      let query = supabase
        .from("sms_log")
        .select("*", { count: "exact" })
        .eq("organization_id", orgId)
        .order("created_at", { ascending: false })
        .range(page * pageSize, (page + 1) * pageSize - 1);

      if (filters?.status) {
        query = query.eq("status", filters.status);
      }
      if (filters?.eventType) {
        query = query.eq("event_type", filters.eventType);
      }

      const { data, error, count } = await query;
      if (error) throw error;
      return { data: (data || []) as SmsLogEntry[], count: count || 0 };
    },
    enabled: !!orgId,
  });
}
