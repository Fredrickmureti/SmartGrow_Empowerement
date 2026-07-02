/**
 * useOnboardingTemplate — single template + item CRUD.
 *
 * Companion to useOnboardingTemplates (list-only). Adds:
 *  - updateTemplate (rename, description, type, is_default)
 *  - addItem / updateItem / deleteItem / reorderItems
 *
 * Uses business_id alongside organization_id because
 * onboarding_templates.business_id is consumed by the list query.
 */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";

export interface TemplateItem {
  id: string;
  template_id: string;
  title: string;
  description: string | null;
  category: string;
  assigned_role: string | null;
  sort_order: number;
  is_required: boolean;
}

export interface Template {
  id: string;
  organization_id: string;
  business_id: string | null;
  name: string;
  description: string | null;
  template_type: string;
  is_active: boolean;
  is_default: boolean;
  items: TemplateItem[];
}

export function useOnboardingTemplate(templateId: string | undefined) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["onboarding-template", templateId] });
    qc.invalidateQueries({ queryKey: ["onboarding-templates"] });
  };

  const { data: template, isLoading } = useQuery({
    queryKey: ["onboarding-template", templateId],
    queryFn: async (): Promise<Template | null> => {
      if (!templateId) return null;
      const { data, error } = await supabase
        .from("onboarding_templates")
        .select("*, onboarding_template_items(*)")
        .eq("id", templateId)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      return {
        ...(data as any),
        items: ((data as any).onboarding_template_items || []).sort(
          (a: any, b: any) => a.sort_order - b.sort_order,
        ),
      };
    },
    enabled: !!templateId,
  });

  const createTemplate = useMutation({
    mutationFn: async (input: { name: string; description?: string; template_type: string }) => {
      if (!currentOrg?.id || !currentBusiness?.id) throw new Error("Select a business first");
      const { data, error } = await supabase
        .from("onboarding_templates")
        .insert({
          organization_id: currentOrg.id,
          business_id: currentBusiness.id,
          name: input.name,
          description: input.description || null,
          template_type: input.template_type,
        } as any)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["onboarding-templates"] });
      toast.success("Template created");
    },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  const updateTemplate = useMutation({
    mutationFn: async (patch: Partial<Pick<Template, "name" | "description" | "template_type" | "is_active" | "is_default">>) => {
      if (!templateId) throw new Error("No template");
      const { error } = await supabase.from("onboarding_templates").update(patch as any).eq("id", templateId);
      if (error) throw error;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Saved");
    },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  const addItem = useMutation({
    mutationFn: async (item: { title: string; description?: string; category?: string; assigned_role?: string; is_required?: boolean }) => {
      if (!templateId) throw new Error("No template");
      const nextOrder = (template?.items?.length ?? 0);
      const { error } = await supabase.from("onboarding_template_items").insert({
        template_id: templateId,
        title: item.title,
        description: item.description || null,
        category: item.category || "general",
        assigned_role: item.assigned_role || null,
        is_required: item.is_required ?? false,
        sort_order: nextOrder,
      } as any);
      if (error) throw error;
    },
    onSuccess: invalidate,
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  const updateItem = useMutation({
    mutationFn: async (input: { id: string; patch: Partial<TemplateItem> }) => {
      const { error } = await supabase
        .from("onboarding_template_items")
        .update(input.patch as any)
        .eq("id", input.id);
      if (error) throw error;
    },
    onSuccess: invalidate,
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  const deleteItem = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("onboarding_template_items").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: invalidate,
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  const move = useMutation({
    mutationFn: async (input: { id: string; direction: "up" | "down" }) => {
      if (!template) return;
      const idx = template.items.findIndex((i) => i.id === input.id);
      const swapIdx = input.direction === "up" ? idx - 1 : idx + 1;
      if (idx < 0 || swapIdx < 0 || swapIdx >= template.items.length) return;
      const a = template.items[idx], b = template.items[swapIdx];
      await supabase.from("onboarding_template_items").update({ sort_order: b.sort_order } as any).eq("id", a.id);
      await supabase.from("onboarding_template_items").update({ sort_order: a.sort_order } as any).eq("id", b.id);
    },
    onSuccess: invalidate,
  });

  return { template, isLoading, createTemplate, updateTemplate, addItem, updateItem, deleteItem, move };
}
