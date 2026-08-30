import { useState, useEffect, useRef, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/contexts/BusinessContext";
import type { 
  DocumentTemplate, 
  DocumentTemplateInput, 
  DocumentTemplateType,
  BankDetails 
} from "@/types/documentTemplate";
import { normalizeError } from "@/services/resilience";

export function useDocumentTemplates(templateType?: DocumentTemplateType) {
  const { toast } = useToast();
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const [templates, setTemplates] = useState<DocumentTemplate[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const hasFetchedRef = useRef(false);

  const fetchTemplates = useCallback(async () => {
    if (!currentOrg?.id || !currentBusiness?.id) return;
    
    setIsLoading(true);
    try {
      let query = supabase
        .from("document_templates")
        .select("*")
        .eq("organization_id", currentOrg.id)
        .or(`business_id.eq.${currentBusiness.id},business_id.is.null`)
        .order("template_name");
      
      if (templateType) {
        query = query.eq("template_type", templateType);
      }

      const { data, error } = await query;

      if (error) throw error;
      
      const parsedTemplates = (data || []).map(t => ({
        ...t,
        columns_layout: { description: 40, quantity: 10, unit_price: 15, tax: 10, amount: 15 } as Record<string, number>,
        bank_details: typeof t.bank_details === 'object' && t.bank_details !== null
          ? t.bank_details as BankDetails
          : {},
      })) as DocumentTemplate[];
      
      setTemplates(parsedTemplates);
    } catch (error: unknown) {
      console.error("Error fetching document templates:", error);
    } finally {
      setIsLoading(false);
    }
  }, [currentOrg?.id, templateType, currentBusiness?.id]);

  useEffect(() => {
    if (currentOrg?.id && !hasFetchedRef.current) {
      hasFetchedRef.current = true;
      fetchTemplates();
    }
  }, [currentOrg?.id, fetchTemplates]);

  useEffect(() => {
    hasFetchedRef.current = false;
  }, [currentOrg?.id, templateType, currentBusiness?.id]);

  const createTemplate = async (input: DocumentTemplateInput): Promise<DocumentTemplate | null> => {
    if (!currentOrg?.id) {
      toast({ title: "Error", description: "No organization selected", variant: "destructive" });
      return null;
    }

    setIsSaving(true);
    try {
      const { data: userData } = await supabase.auth.getUser();
      
      const insertData = {
        organization_id: currentOrg.id,
        business_id: input.business_id || null,
        template_type: input.template_type,
        template_name: input.template_name,
        is_default: input.is_default ?? false,
        is_active: input.is_active ?? true,
        
        // Header
        show_company_name: input.show_company_name ?? true,
        show_company_address: input.show_company_address ?? true,
        show_company_phone: input.show_company_phone ?? true,
        show_company_email: input.show_company_email ?? true,
        show_tax_id: input.show_tax_id ?? false,
        header_text: input.header_text || null,
        document_title_format: input.document_title_format || 'INVOICE',
        
        // Content
        show_line_numbers: input.show_line_numbers ?? true,
        show_item_sku: input.show_item_sku ?? false,
        show_item_description: input.show_item_description ?? true,
        show_unit_price: input.show_unit_price ?? true,
        show_quantity: input.show_quantity ?? true,
        show_tax_column: input.show_tax_column ?? true,
        show_discount_column: input.show_discount_column ?? false,
        show_subtotals_per_item: input.show_subtotals_per_item ?? false,
        columns_layout: input.columns_layout || { description: 40, quantity: 10, unit_price: 15, tax: 10, amount: 15 },
        
        // Totals
        show_subtotal: input.show_subtotal ?? true,
        show_discount_total: input.show_discount_total ?? true,
        show_tax_breakdown: input.show_tax_breakdown ?? true,
        show_total_in_words: input.show_total_in_words ?? false,
        totals_position: input.totals_position || 'right',
        
        // Footer
        show_payment_instructions: input.show_payment_instructions ?? true,
        payment_instructions: input.payment_instructions || null,
        bank_details: input.bank_details || {},
        show_bank_details: input.show_bank_details ?? true,
        footer_text: input.footer_text || null,
        show_signature_line: input.show_signature_line ?? false,
        signature_label: input.signature_label || 'Authorized Signature',
        show_terms: input.show_terms ?? true,
        terms_text: input.terms_text || null,
        
        // Payment methods (override filter only)
        payment_method_ids: input.payment_method_ids || [],
        
        // Status badge
        show_status_badge: input.show_status_badge ?? false,
        
        // Advanced
        watermark_text: input.watermark_text || null,
        watermark_opacity: input.watermark_opacity ?? 0.1,
        
        created_by: userData.user?.id || null,
      };

      const { data, error } = await supabase
        .from("document_templates")
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .insert(insertData as any)
        .select()
        .single();

      if (error) throw error;

      toast({ title: "Template created", description: `${input.template_name} has been created.` });
      await fetchTemplates();
      
      return data as DocumentTemplate;
    } catch (error: unknown) {
      const err = error as Error;
      toast({ title: "Error", description: normalizeError(err).message || "Failed to create template", variant: "destructive" });
      return null;
    } finally {
      setIsSaving(false);
    }
  };

  const updateTemplate = async (id: string, updates: Partial<DocumentTemplateInput>): Promise<boolean> => {
    setIsSaving(true);
    try {
      if (!currentBusiness?.id) {
        toast({ title: "Error", description: "Select a Company before editing templates", variant: "destructive" });
        return false;
      }
      const updateData = { ...updates, updated_at: new Date().toISOString() };
      const { error } = await supabase
        .from("document_templates")
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .update(updateData as any)
        .eq("id", id)
        .eq("organization_id", currentOrg.id)
        .or(`business_id.eq.${currentBusiness.id},business_id.is.null`);

      if (error) throw error;
      toast({ title: "Template updated" });
      await fetchTemplates();
      return true;
    } catch (error: unknown) {
      const err = error as Error;
      toast({ title: "Error", description: normalizeError(err).message, variant: "destructive" });
      return false;
    } finally {
      setIsSaving(false);
    }
  };

  const deleteTemplate = async (id: string): Promise<boolean> => {
    try {
      if (!currentOrg?.id || !currentBusiness?.id) {
        toast({ title: "Error", description: "Select a Company before deleting templates", variant: "destructive" });
        return false;
      }
      const { error } = await supabase
        .from("document_templates")
        .delete()
        .eq("id", id)
        .eq("organization_id", currentOrg.id)
        .or(`business_id.eq.${currentBusiness.id},business_id.is.null`);
        
      if (error) throw error;
      toast({ title: "Template deleted" });
      await fetchTemplates();
      return true;
    } catch (error: unknown) {
      const err = error as Error;
      toast({ title: "Error", description: normalizeError(err).message, variant: "destructive" });
      return false;
    }
  };

  const duplicateTemplate = async (id: string, newName: string): Promise<DocumentTemplate | null> => {
    const template = templates.find(t => t.id === id);
    if (!template) return null;

    const { id: _, created_at, updated_at, created_by, ...rest } = template;
    
    return await createTemplate({
      ...rest,
      template_name: newName,
      is_default: false,
    });
  };

  const setAsDefault = async (id: string): Promise<boolean> => {
    const template = templates.find(t => t.id === id);
    if (!template) return false;
    
    return await updateTemplate(id, { is_default: true });
  };

  const getTemplateById = (id: string): DocumentTemplate | undefined => {
    return templates.find(t => t.id === id);
  };

  const getDefaultTemplate = (type: DocumentTemplateType, businessId?: string): DocumentTemplate | undefined => {
    if (businessId) {
      const businessDefault = templates.find(
        t => t.template_type === type && t.business_id === businessId && t.is_default
      );
      if (businessDefault) return businessDefault;
    }
    
    return templates.find(
      t => t.template_type === type && t.business_id === null && t.is_default
    );
  };

  const getTemplatesByType = (type: DocumentTemplateType): DocumentTemplate[] => {
    return templates.filter(t => t.template_type === type);
  };

  const getTemplatesForBusiness = (businessId: string): DocumentTemplate[] => {
    return templates.filter(t => t.business_id === businessId || t.business_id === null);
  };

  return {
    templates,
    isLoading,
    isSaving,
    createTemplate,
    updateTemplate,
    deleteTemplate,
    duplicateTemplate,
    setAsDefault,
    getTemplateById,
    getDefaultTemplate,
    getTemplatesByType,
    getTemplatesForBusiness,
    refreshTemplates: fetchTemplates,
  };
}
