import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";

export interface OnboardingTemplate {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
  template_type: string;
  is_active: boolean;
  created_at: string;
  items?: OnboardingTemplateItem[];
}

export interface OnboardingTemplateItem {
  id: string;
  template_id: string;
  title: string;
  description: string | null;
  category: string;
  assigned_role: string | null;
  sort_order: number;
  is_required: boolean;
}

export interface EmployeeOnboarding {
  id: string;
  organization_id: string;
  employee_id: string;
  template_id: string | null;
  onboarding_type: string;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  notes: string | null;
  created_at: string;
  items?: EmployeeOnboardingItem[];
}

export interface EmployeeOnboardingItem {
  id: string;
  onboarding_id: string;
  title: string;
  description: string | null;
  category: string;
  is_completed: boolean;
  completed_by: string | null;
  completed_at: string | null;
  notes: string | null;
  sort_order: number;
}

export function useOnboardingTemplates() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const queryClient = useQueryClient();

  const { data: templates = [], isLoading } = useQuery({
    queryKey: ["onboarding-templates", currentOrg?.id],
    queryFn: async () => {
      if (!currentOrg?.id) return [];
      const { data, error } = await supabase
        .from("onboarding_templates")
        .select("*, onboarding_template_items(*)")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data || []).map((t: any) => ({
        ...t,
        items: t.onboarding_template_items || [],
      })) as OnboardingTemplate[];
    },
    enabled: !!currentOrg?.id,
  });

  const createTemplate = useMutation({
    mutationFn: async (input: { name: string; description?: string; template_type: string; items: { title: string; description?: string; category?: string; sort_order?: number }[] }) => {
      if (!currentOrg?.id) throw new Error("No org");
      const { data: template, error } = await supabase
        .from("onboarding_templates")
        .insert({ organization_id: currentOrg.id, name: input.name, description: input.description || null, template_type: input.template_type })
        .select()
        .single();
      if (error) throw error;

      if (input.items.length > 0) {
        const { error: itemsErr } = await supabase
          .from("onboarding_template_items")
          .insert(input.items.map((item, i) => ({ template_id: template.id, title: item.title, description: item.description || null, category: item.category || "general", sort_order: item.sort_order ?? i })));
        if (itemsErr) throw itemsErr;
      }
      return template;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["onboarding-templates"] });
      toast.success("Template created");
    },
    onError: (err: any) => toast.error(normalizeError(err).message),
  });

  const deleteTemplate = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("onboarding_templates").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["onboarding-templates"] });
      toast.success("Template deleted");
    },
    onError: (err: any) => toast.error(normalizeError(err).message),
  });

  return { templates, isLoading, createTemplate, deleteTemplate };
}

export function useEmployeeOnboarding(employeeId: string | undefined) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const queryClient = useQueryClient();

  const { data: onboardings = [], isLoading } = useQuery({
    queryKey: ["employee-onboarding", employeeId, currentOrg?.id],
    queryFn: async () => {
      if (!employeeId || !currentOrg?.id) return [];
      const { data, error } = await supabase
        .from("employee_onboarding")
        .select("*, employee_onboarding_items(*)")
        .eq("employee_id", employeeId)
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data || []).map((o: any) => ({
        ...o,
        items: (o.employee_onboarding_items || []).sort((a: any, b: any) => a.sort_order - b.sort_order),
      })) as EmployeeOnboarding[];
    },
    enabled: !!employeeId && !!currentOrg?.id,
  });

  const startOnboarding = useMutation({
    mutationFn: async (input: { templateId: string; type: string }) => {
      if (!employeeId || !currentOrg?.id) throw new Error("Missing context");
      if (!currentBusiness?.id) {
        // employee_onboarding.business_id became NOT NULL in 20260419234846.
        // Without a current business the insert would fail at the DB level
        // with a generic NOT NULL violation; surface a clear message instead.
        throw new Error("Select a business before starting onboarding");
      }

      // Fetch template items
      const { data: templateItems } = await supabase
        .from("onboarding_template_items")
        .select("*")
        .eq("template_id", input.templateId)
        .order("sort_order");

      const { data: onboarding, error } = await supabase
        .from("employee_onboarding")
        .insert({
          organization_id: currentOrg.id,
          business_id: currentBusiness.id,
          employee_id: employeeId,
          template_id: input.templateId,
          onboarding_type: input.type,
        })
        .select()
        .single();
      if (error) throw error;

      if (templateItems?.length) {
        await supabase.from("employee_onboarding_items").insert(
          templateItems.map((item: any) => ({
            onboarding_id: onboarding.id,
            template_item_id: item.id,
            title: item.title,
            description: item.description,
            category: item.category,
            sort_order: item.sort_order,
          }))
        );
      }
      return onboarding;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["employee-onboarding", employeeId] });
      toast.success("Onboarding started");
    },
    onError: (err: any) => toast.error(normalizeError(err).message),
  });

  const toggleItem = useMutation({
    mutationFn: async ({ itemId, completed }: { itemId: string; completed: boolean }) => {
      const { error } = await supabase
        .from("employee_onboarding_items")
        .update({
          is_completed: completed,
          completed_at: completed ? new Date().toISOString() : null,
        })
        .eq("id", itemId);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["employee-onboarding", employeeId] }),
  });

  const completeOnboarding = useMutation({
    mutationFn: async (onboardingId: string) => {
      const { error } = await supabase
        .from("employee_onboarding")
        .update({ status: "completed", completed_at: new Date().toISOString() })
        .eq("id", onboardingId);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["employee-onboarding", employeeId] });
      toast.success("Onboarding completed");
    },
  });

  return { onboardings, isLoading, startOnboarding, toggleItem, completeOnboarding };
}
