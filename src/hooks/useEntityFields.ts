import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { toast } from "sonner";

// Supported entity types
export type EntityType = 
  | "contact" 
  | "product" 
  | "invoice" 
  | "estimate"
  | "sales_order"
  | "purchase_order"
  | "project"
  | "crm_lead"
  | "expense"
  | "bill"
  | "employee"
  | "credit_note"
  | "payment"
  | "delivery_note"
  | "sales_return"
  | "proforma_invoice"
  | "recurring_invoice"
  | "stock_adjustment";

export type FieldType = 
  | "text" 
  | "number" 
  | "date" 
  | "datetime" 
  | "boolean" 
  | "select" 
  | "multiselect" 
  | "related" 
  | "computed" 
  | "html" 
  | "file";

export interface FieldOption {
  value: string;
  label: string;
  color?: string;
}

export interface ValidationRules {
  min?: number;
  max?: number;
  regex?: string;
  message?: string;
}

export interface ConditionalVisibility {
  field: string;
  operator: "=" | "!=" | ">" | "<" | ">=" | "<=" | "contains" | "not_contains" | "is_empty" | "is_not_empty";
  value?: string | number | boolean;
}

export interface EntityFieldConfig {
  id: string;
  organization_id: string;
  business_id: string | null;
  entity_type: EntityType;
  field_key: string;
  field_label: string;
  field_type: FieldType;
  is_required: boolean;
  is_visible: boolean;
  is_searchable: boolean;
  is_filterable: boolean;
  display_order: number;
  options: FieldOption[];
  default_value: string | null;
  validation_rules: ValidationRules;
  related_model: string | null;
  related_display_field: string | null;
  related_filter: Record<string, any> | null;
  computation_formula: string | null;
  computation_dependencies: string[] | null;
  conditional_visibility: ConditionalVisibility | null;
  placeholder: string | null;
  help_text: string | null;
  field_group: string | null;
  document_section: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

export interface EntityFieldValue {
  id: string;
  organization_id: string;
  entity_type: EntityType;
  entity_id: string;
  field_config_id: string;
  field_key: string;
  field_value: string | null;
  field_value_json: Record<string, any> | null;
  created_at: string;
  updated_at: string;
  updated_by: string | null;
}

// Entity type labels for UI display
export const ENTITY_TYPE_LABELS: Record<EntityType, string> = {
  contact: "Contacts",
  product: "Products",
  invoice: "Invoices",
  estimate: "Estimates",
  sales_order: "Sales Orders",
  purchase_order: "Purchase Orders",
  project: "Projects",
  crm_lead: "CRM Leads",
  expense: "Expenses",
  bill: "Bills",
  employee: "Employees",
  credit_note: "Credit Notes",
  payment: "Payments",
  delivery_note: "Delivery Notes",
  sales_return: "Sales Returns",
  proforma_invoice: "Proforma Invoices",
  recurring_invoice: "Recurring Invoices",
  stock_adjustment: "Stock Adjustments",
};

// Field type labels for UI display
export const FIELD_TYPE_LABELS: Record<FieldType, string> = {
  text: "Text",
  number: "Number",
  date: "Date",
  datetime: "Date & Time",
  boolean: "Yes/No",
  select: "Dropdown",
  multiselect: "Multi-Select",
  related: "Related Record",
  computed: "Computed",
  html: "Rich Text",
  file: "File Upload",
};

/**
 * Hook for managing entity field configurations for a specific entity type
 */
export function useEntityFields(entityType: EntityType) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const [fieldConfigs, setFieldConfigs] = useState<EntityFieldConfig[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchFieldConfigs = useCallback(async () => {
    // Guard against null currentBusiness — query would throw on .id access.
    if (!currentOrg || !currentBusiness) {
      setIsLoading(false);
      return;
    }
    setIsLoading(true);

    try {
      const { data, error } = await supabase
        .from("entity_field_configs")
        .select("*")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .eq("entity_type", entityType)
        .order("display_order");

      if (error) throw error;
      
      setFieldConfigs((data || []) as unknown as EntityFieldConfig[]);
    } catch (error) {
      console.error("Error fetching entity field configs:", error);
      toast.error("Failed to fetch field configurations");
    } finally {
      setIsLoading(false);
    }
  }, [currentOrg?.id, currentBusiness?.id, entityType]);

  useEffect(() => {
    fetchFieldConfigs();
  }, [fetchFieldConfigs]);

  const addField = async (
    fieldLabel: string,
    fieldType: FieldType = "text",
    options?: Partial<EntityFieldConfig>
  ) => {
    if (!currentOrg) throw new Error("No organization selected");

    const fieldKey = `custom_${fieldLabel.toLowerCase().replace(/\s+/g, "_")}_${Date.now()}`;
    
    const maxOrder = fieldConfigs.length > 0 
      ? Math.max(...fieldConfigs.map(f => f.display_order)) 
      : 0;

    const { data, error } = await supabase
      .from("entity_field_configs")
      .insert({
        organization_id: currentOrg.id,
        business_id: currentBusiness.id,
        entity_type: entityType,
        field_key: fieldKey,
        field_label: fieldLabel,
        field_type: fieldType,
        is_required: options?.is_required ?? false,
        is_visible: options?.is_visible ?? true,
        is_searchable: options?.is_searchable ?? false,
        is_filterable: options?.is_filterable ?? false,
        display_order: maxOrder + 1,
        options: (options?.options ?? []) as unknown as any,
        default_value: options?.default_value ?? null,
        validation_rules: (options?.validation_rules ?? {}) as unknown as any,
        related_model: options?.related_model ?? null,
        related_display_field: options?.related_display_field ?? null,
        placeholder: options?.placeholder ?? null,
        help_text: options?.help_text ?? null,
        field_group: options?.field_group ?? null,
      } as any)
      .select()
      .single();

    if (error) throw error;
    
    toast.success(`Custom field "${fieldLabel}" added`);
    await fetchFieldConfigs();
    return data as unknown as EntityFieldConfig;
  };

  const updateField = async (id: string, updates: Partial<EntityFieldConfig>) => {
    const { error } = await supabase
      .from("entity_field_configs")
      .update(updates as any)
      .eq("id", id);

    if (error) throw error;
    
    toast.success("Field configuration updated");
    await fetchFieldConfigs();
  };

  const deleteField = async (id: string) => {
    const { error } = await supabase
      .from("entity_field_configs")
      .delete()
      .eq("id", id);

    if (error) throw error;
    
    toast.success("Custom field deleted");
    await fetchFieldConfigs();
  };

  const reorderFields = async (reorderedFields: EntityFieldConfig[]) => {
    const updates = reorderedFields.map((field, index) => ({
      id: field.id,
      display_order: index,
    }));

    for (const update of updates) {
      await supabase
        // SCOPE-EXEMPT: `entity_field_configs` is workspace-wide (no business_id column)
        .from("entity_field_configs")
        .update({ display_order: update.display_order })
        .eq("id", update.id);
    }

    await fetchFieldConfigs();
    toast.success("Field order updated");
  };

  // Get fields grouped by group name
  const getFieldsByGroup = (group: string | null) => {
    return fieldConfigs
      .filter(f => f.field_group === group && f.is_visible)
      .sort((a, b) => a.display_order - b.display_order);
  };

  // Get all visible fields
  const visibleFields = fieldConfigs
    .filter(f => f.is_visible)
    .sort((a, b) => a.display_order - b.display_order);

  // Get searchable fields
  const searchableFields = fieldConfigs.filter(f => f.is_searchable);

  // Get filterable fields
  const filterableFields = fieldConfigs.filter(f => f.is_filterable);

  return {
    fieldConfigs,
    isLoading,
    addField,
    updateField,
    deleteField,
    reorderFields,
    getFieldsByGroup,
    visibleFields,
    searchableFields,
    filterableFields,
    refreshFieldConfigs: fetchFieldConfigs,
  };
}

/**
 * Hook for managing custom field values for a specific entity instance
 */
export function useEntityFieldValues(entityType: EntityType, entityId: string | null) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const [fieldValues, setFieldValues] = useState<EntityFieldValue[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const fetchFieldValues = useCallback(async () => {
    if (!entityId || !currentOrg) return;
    setIsLoading(true);

    try {
      const { data, error } = await supabase
        .from("entity_field_values")
        .select("*")
        .eq("organization_id", currentOrg.id)
        .eq("entity_type", entityType)
        .eq("entity_id", entityId);

      if (error) throw error;
      setFieldValues((data || []) as unknown as EntityFieldValue[]);
    } catch (error) {
      console.error("Error fetching field values:", error);
    } finally {
      setIsLoading(false);
    }
  }, [entityId, entityType, currentOrg?.id]);

  useEffect(() => {
    fetchFieldValues();
  }, [fetchFieldValues]);

  const saveFieldValue = async (
    fieldConfigId: string,
    fieldKey: string, 
    value: string | null,
    valueJson?: Record<string, any> | null
  ) => {
    if (!entityId || !currentOrg) throw new Error("No entity or organization selected");

    const { error } = await supabase
      .from("entity_field_values")
      .upsert({
        organization_id: currentOrg.id,
        entity_type: entityType,
        entity_id: entityId,
        field_config_id: fieldConfigId,
        field_key: fieldKey,
        field_value: value,
        field_value_json: valueJson ?? null,
      }, {
        onConflict: "organization_id,entity_type,entity_id,field_key",
      });

    if (error) throw error;
    await fetchFieldValues();
  };

  const saveMultipleFieldValues = async (
    values: Array<{ fieldConfigId: string; fieldKey: string; value: string | null; valueJson?: Record<string, any> | null }>
  ) => {
    if (!entityId || !currentOrg) throw new Error("No entity or organization selected");

    const records = values.map(v => ({
      organization_id: currentOrg.id,
      entity_type: entityType,
      entity_id: entityId,
      field_config_id: v.fieldConfigId,
      field_key: v.fieldKey,
      field_value: v.value,
      field_value_json: v.valueJson ?? null,
    }));

    const { error } = await supabase
      .from("entity_field_values")
      .upsert(records, {
        onConflict: "organization_id,entity_type,entity_id,field_key",
      });

    if (error) throw error;
    await fetchFieldValues();
  };

  const getFieldValue = (fieldKey: string): string | null => {
    const field = fieldValues.find(f => f.field_key === fieldKey);
    return field?.field_value ?? null;
  };

  const getFieldValueJson = (fieldKey: string): Record<string, any> | null => {
    const field = fieldValues.find(f => f.field_key === fieldKey);
    return field?.field_value_json ?? null;
  };

  const deleteFieldValue = async (fieldKey: string) => {
    if (!entityId || !currentOrg) return;

    const { error } = await supabase
      .from("entity_field_values")
      .delete()
      .eq("organization_id", currentOrg.id)
      .eq("entity_type", entityType)
      .eq("entity_id", entityId)
      .eq("field_key", fieldKey);

    if (error) throw error;
    await fetchFieldValues();
  };

  return {
    fieldValues,
    isLoading,
    saveFieldValue,
    saveMultipleFieldValues,
    getFieldValue,
    getFieldValueJson,
    deleteFieldValue,
    refreshFieldValues: fetchFieldValues,
  };
}

/**
 * Hook for fetching all entity field configurations across all entity types
 */
export function useAllEntityFields() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const [allFieldConfigs, setAllFieldConfigs] = useState<EntityFieldConfig[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchAllFieldConfigs = useCallback(async () => {
    if (!currentOrg) return;
    setIsLoading(true);

    try {
      const { data, error } = await supabase
        // SCOPE-EXEMPT: entity_field_configs is workspace-wide custom field schema
        .from("entity_field_configs")
        .select("*")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .order("entity_type")
        .order("display_order");

      if (error) throw error;
      setAllFieldConfigs((data || []) as unknown as EntityFieldConfig[]);
    } catch (error) {
      console.error("Error fetching all entity field configs:", error);
    } finally {
      setIsLoading(false);
    }
  }, [currentOrg?.id]);

  useEffect(() => {
    fetchAllFieldConfigs();
  }, [fetchAllFieldConfigs]);

  const getFieldsForEntityType = (entityType: EntityType) => {
    return allFieldConfigs
      .filter(f => f.entity_type === entityType)
      .sort((a, b) => a.display_order - b.display_order);
  };

  const getFieldCountByEntityType = () => {
    const counts: Record<EntityType, number> = {} as Record<EntityType, number>;
    for (const entityType of Object.keys(ENTITY_TYPE_LABELS) as EntityType[]) {
      counts[entityType] = allFieldConfigs.filter(f => f.entity_type === entityType).length;
    }
    return counts;
  };

  return {
    allFieldConfigs,
    isLoading,
    getFieldsForEntityType,
    getFieldCountByEntityType,
    refreshAllFieldConfigs: fetchAllFieldConfigs,
  };
}
