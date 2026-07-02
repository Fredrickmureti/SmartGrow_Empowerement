import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { toast } from "sonner";
import type { Database } from "@/integrations/supabase/types";
import { normalizeError } from "@/services/resilience";

type SmsEventType = Database["public"]["Enums"]["sms_event_type"];

export interface SmsTemplate {
  id: string;
  organization_id: string;
  business_id: string | null;
  event_type: SmsEventType;
  name: string;
  body_template: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export function useSmsTemplates() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const queryClient = useQueryClient();
  const orgId = currentOrg?.id;
  const businessId = currentBusiness?.id;

  const templatesQuery = useQuery({
    queryKey: ["sms-templates", orgId, businessId ?? "all-businesses"],
    queryFn: async () => {
      if (!orgId) return [];
      const query = supabase
        .from("sms_templates")
        .select("*")
        .eq("organization_id", orgId)
        .order("event_type")
        .order("created_at", { ascending: false });
      const { data, error } = await query;
      if (error) throw error;
      return (data || []) as SmsTemplate[];
    },
    enabled: !!orgId,
  });

  const upsertTemplate = useMutation({
    mutationFn: async (template: {
      id?: string;
      event_type: SmsEventType;
      name: string;
      body_template: string;
      is_active?: boolean;
    }) => {
      if (!orgId) throw new Error("No organization");
      const { id, ...rest } = template;

      if (id) {
        const { error } = await supabase
          .from("sms_templates")
          .update(rest)
          .eq("id", id);
        if (error) throw error;
      } else {
        if (rest.is_active ?? true) {
          const { data: existingActive, error: existingError } = await supabase
            .from("sms_templates")
            .select("id")
            .eq("organization_id", orgId)
            .eq("event_type", rest.event_type)
            .eq("is_active", true)
            .maybeSingle();
          if (existingError) throw existingError;
          if (existingActive?.id) {
            const { error } = await supabase
              .from("sms_templates")
              .update(rest)
              .eq("id", existingActive.id);
            if (error) throw error;
            return;
          }
        }

        const { error } = await supabase
          .from("sms_templates")
          .insert([{ ...rest, organization_id: orgId, business_id: businessId ?? null }]);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sms-templates", orgId] });
      toast.success("Template saved");
    },
    onError: (err: Error) => toast.error(normalizeError(err).message),
  });

  const deleteTemplate = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("sms_templates").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sms-templates", orgId] });
      toast.success("Template deleted");
    },
    onError: (err: Error) => toast.error(normalizeError(err).message),
  });

  return {
    templates: templatesQuery.data || [],
    isLoading: templatesQuery.isLoading,
    upsertTemplate,
    deleteTemplate,
  };
}
