import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { toast } from "sonner";
import type { Database } from "@/integrations/supabase/types";
import { normalizeError } from "@/services/resilience";

type AppRole = Database["public"]["Enums"]["app_role"];

export interface SmsRuleRecipient {
  id: string;
  rule_id: string;
  recipient_kind: "group" | "phone" | "role" | "user";
  group_id: string | null;
  phone: string | null;
  role: AppRole | null;
  user_id: string | null;
  is_fallback: boolean;
  created_at: string;
}

export interface SmsRecipientGroup {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
  created_at: string;
}

export function useSmsRecipientGroups() {
  const { currentOrg } = useOrganization();
  const orgId = currentOrg?.id;
  const qc = useQueryClient();

  const groupsQuery = useQuery({
    queryKey: ["sms-recipient-groups", orgId],
    enabled: !!orgId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sms_recipient_groups")
        .select("*")
        .eq("organization_id", orgId!)
        .order("name");
      if (error) throw error;
      return (data || []) as SmsRecipientGroup[];
    },
  });

  const createGroup = useMutation({
    mutationFn: async (name: string) => {
      if (!orgId) throw new Error("No organization");
      const { data, error } = await supabase
        .from("sms_recipient_groups")
        .insert({ organization_id: orgId, name })
        .select("*")
        .single();
      if (error) throw error;
      return data as SmsRecipientGroup;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sms-recipient-groups", orgId] });
      toast.success("Group created");
    },
    onError: (e: Error) => toast.error(normalizeError(e).message),
  });

  return { groups: groupsQuery.data || [], isLoading: groupsQuery.isLoading, createGroup };
}

export function useSmsRuleRecipients(ruleId: string | null | undefined) {
  const qc = useQueryClient();

  const recipientsQuery = useQuery({
    queryKey: ["sms-rule-recipients", ruleId],
    enabled: !!ruleId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sms_event_rule_recipients")
        .select("*")
        .eq("rule_id", ruleId!)
        .order("created_at");
      if (error) throw error;
      return (data || []) as SmsRuleRecipient[];
    },
  });

  const addRecipient = useMutation({
    mutationFn: async (input: {
      recipient_kind: "group" | "phone" | "role" | "user";
      group_id?: string | null;
      phone?: string | null;
      role?: AppRole | null;
      user_id?: string | null;
      is_fallback?: boolean;
    }) => {
      if (!ruleId) throw new Error("No rule");
      const { error } = await supabase
        .from("sms_event_rule_recipients")
        .insert({ rule_id: ruleId, ...input });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sms-rule-recipients", ruleId] }),
    onError: (e: Error) => toast.error(normalizeError(e).message),
  });

  const removeRecipient = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("sms_event_rule_recipients")
        .delete()
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sms-rule-recipients", ruleId] }),
    onError: (e: Error) => toast.error(normalizeError(e).message),
  });

  const toggleFallback = useMutation({
    mutationFn: async ({ id, is_fallback }: { id: string; is_fallback: boolean }) => {
      const { error } = await supabase
        .from("sms_event_rule_recipients")
        .update({ is_fallback })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sms-rule-recipients", ruleId] }),
  });

  return {
    recipients: recipientsQuery.data || [],
    isLoading: recipientsQuery.isLoading,
    addRecipient,
    removeRecipient,
    toggleFallback,
  };
}