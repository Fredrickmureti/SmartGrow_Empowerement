import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "./use-toast";
import { normalizeError } from "@/services/resilience";

export interface RecurringTemplateLine {
  account_id: string;
  account_name?: string;
  debit: number;
  credit: number;
  description: string;
}

export interface RecurringTemplate {
  id: string;
  template_name: string;
  description: string | null;
  frequency: "monthly" | "quarterly" | "annually";
  next_run_date: string;
  end_date: string | null;
  is_auto_post: boolean;
  is_active: boolean;
  source_type: string;
  reference_prefix: string | null;
  lines: RecurringTemplateLine[];
  created_at: string;
}

export interface CreateTemplateInput {
  template_name: string;
  description?: string;
  frequency: "monthly" | "quarterly" | "annually";
  next_run_date: string;
  end_date?: string;
  is_auto_post?: boolean;
  source_type?: string;
  reference_prefix?: string;
  lines: RecurringTemplateLine[];
}

export function useRecurringJournals() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: templates = [], isLoading } = useQuery({
    queryKey: ["recurring-templates", currentOrg?.id],
    queryFn: async () => {
      if (!currentOrg?.id) return [];
      const { data, error } = await supabase
        .from("recurring_journal_templates" as any)
        .select("*")
        .eq("organization_id", currentOrg.id)
        .order("next_run_date", { ascending: true });
      if (error) throw error;
      return (data || []).map((t: any) => ({
        ...t,
        lines: Array.isArray(t.lines) ? t.lines : JSON.parse(t.lines || "[]"),
      })) as RecurringTemplate[];
    },
    enabled: !!currentOrg?.id,
  });

  const createTemplate = useMutation({
    mutationFn: async (input: CreateTemplateInput) => {
      if (!currentOrg?.id || !user?.id) throw new Error("Not authenticated");
      const { data, error } = await supabase
        .from("recurring_journal_templates" as any)
        .insert({
          organization_id: currentOrg.id,
          business_id: currentBusiness?.id || null,
          template_name: input.template_name,
          description: input.description || null,
          frequency: input.frequency,
          next_run_date: input.next_run_date,
          end_date: input.end_date || null,
          is_auto_post: input.is_auto_post || false,
          source_type: input.source_type || "manual",
          reference_prefix: input.reference_prefix || null,
          lines: JSON.stringify(input.lines),
          created_by: user.id,
        } as any)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      toast({ title: "Template created" });
      queryClient.invalidateQueries({ queryKey: ["recurring-templates"] });
    },
    onError: (e: any) => {
      toast({ title: "Error", description: normalizeError(e).message, variant: "destructive" });
    },
  });

  const deleteTemplate = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("recurring_journal_templates" as any)
        .delete()
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "Template deleted" });
      queryClient.invalidateQueries({ queryKey: ["recurring-templates"] });
    },
  });

  const toggleActive = useMutation({
    mutationFn: async ({ id, is_active }: { id: string; is_active: boolean }) => {
      const { error } = await supabase
        .from("recurring_journal_templates" as any)
        .update({ is_active } as any)
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["recurring-templates"] });
    },
  });

  return {
    templates,
    isLoading,
    createTemplate,
    deleteTemplate,
    toggleActive,
  };
}
