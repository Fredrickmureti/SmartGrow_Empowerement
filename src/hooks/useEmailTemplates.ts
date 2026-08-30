import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";

export interface EmailTemplate {
  id: string;
  organization_id: string;
  business_id: string | null;
  template_key: string;
  name: string;
  subject: string;
  html_body: string;
  text_body: string | null;
  variables: string[];
  is_active: boolean;
  is_default: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

const DEFAULT_TEMPLATE_KEYS = [
  "invoice_sent",
  "payment_reminder",
  "payment_receipt",
  "estimate_sent",
  "invoice_overdue",
] as const;

export type TemplateKey = (typeof DEFAULT_TEMPLATE_KEYS)[number];

export function useEmailTemplates() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const queryClient = useQueryClient();
  const organizationId = currentOrg?.id;

  // Ensure default templates exist
  const ensureDefaults = async () => {
    if (!organizationId) return;
    
    await supabase.rpc("ensure_default_email_templates", { _org_id: organizationId });
  };

  // Fetch email templates
  const { data: templates = [], isLoading } = useQuery({
    queryKey: ["email-templates", organizationId, currentBusiness?.id],
    queryFn: async () => {
      if (!organizationId) return [];

      // First ensure defaults exist
      await ensureDefaults();

      let query = supabase
        .from("email_templates")
        .select("*")
        .eq("organization_id", organizationId);

      if (currentBusiness) {
        query = query.or(`business_id.eq.${currentBusiness.id},business_id.is.null`);
      }

      const { data, error } = await query.order("name");

      if (error) throw error;
      return data as EmailTemplate[];
    },
    enabled: !!organizationId,
  });

  // Get template by key
  const getTemplateByKey = (key: TemplateKey): EmailTemplate | undefined => {
    // Prefer business-specific template, fallback to org-level
    const businessTemplate = templates.find(
      (t) => t.template_key === key && t.business_id === currentBusiness?.id
    );
    if (businessTemplate) return businessTemplate;

    return templates.find(
      (t) => t.template_key === key && t.business_id === null
    );
  };

  // Create template
  const createTemplate = useMutation({
    mutationFn: async (
      template: Omit<EmailTemplate, "id" | "organization_id" | "created_at" | "updated_at" | "created_by">
    ) => {
      if (!organizationId) throw new Error("No organization selected");

      const { data: userData } = await supabase.auth.getUser();

      const { data, error } = await supabase
        .from("email_templates")
        .insert({
          ...template,
          body: template.html_body ?? template.text_body ?? "",
          organization_id: organizationId,
          business_id: currentBusiness?.id || null,
          created_by: userData?.user?.id,
        })
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["email-templates"] });
      toast.success("Email template created");
    },
    onError: (error) => {
      toast.error("Failed to create template: " + normalizeError(error).message);
    },
  });

  // Update template
  const updateTemplate = useMutation({
    mutationFn: async ({
      id,
      ...updates
    }: Partial<EmailTemplate> & { id: string }) => {
      const { error } = await supabase
        .from("email_templates")
        .update({
          ...updates,
          updated_at: new Date().toISOString(),
        })
        .eq("id", id);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["email-templates"] });
      toast.success("Email template updated");
    },
    onError: (error) => {
      toast.error("Failed to update template: " + normalizeError(error).message);
    },
  });

  // Delete template
  const deleteTemplate = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("email_templates")
        .delete()
        .eq("id", id);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["email-templates"] });
      toast.success("Email template deleted");
    },
    onError: (error) => {
      toast.error("Failed to delete template: " + normalizeError(error).message);
    },
  });

  // Reset template to default
  const resetToDefault = useMutation({
    mutationFn: async (templateKey: TemplateKey) => {
      if (!organizationId) throw new Error("No organization selected");

      // Delete existing custom template (covers both org-level and any company-level overrides)
      // SCOPE-EXEMPT: reset removes all customizations of this template_key in the workspace
      await supabase
        .from("email_templates")
        .delete()
        .eq("organization_id", organizationId)
        .eq("template_key", templateKey);

      // Re-create default
      await ensureDefaults();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["email-templates"] });
      toast.success("Template reset to default");
    },
    onError: (error) => {
      toast.error("Failed to reset template: " + normalizeError(error).message);
    },
  });

  const reseedDefaults = async () => {
    if (!organizationId) return;
    await supabase.rpc("ensure_default_email_templates", { _org_id: organizationId });
    await queryClient.invalidateQueries({ queryKey: ["email-templates"] });
  };

  return {
    templates,
    isLoading,
    getTemplateByKey,
    createTemplate,
    updateTemplate,
    deleteTemplate,
    resetToDefault,
    reseedDefaults,
    templateKeys: DEFAULT_TEMPLATE_KEYS,
  };
}
