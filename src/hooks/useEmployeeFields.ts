import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { toast } from "sonner";

export interface EmployeeFieldConfig {
  id: string;
  organization_id: string;
  field_key: string;
  field_label: string;
  field_type: "text" | "number" | "date" | "select" | "email" | "phone" | "textarea";
  field_category: "personal" | "employment" | "statutory" | "banking" | "custom";
  is_required: boolean;
  is_visible: boolean;
  is_system: boolean;
  display_order: number;
  options: { value: string; label: string }[] | null;
  placeholder: string | null;
  help_text: string | null;
  created_at: string;
  updated_at: string;
}

export interface EmployeeCustomField {
  id: string;
  employee_id: string;
  field_key: string;
  field_value: string | null;
}

// Default field configurations for new organizations
export const DEFAULT_EMPLOYEE_FIELDS: Omit<EmployeeFieldConfig, "id" | "organization_id" | "created_at" | "updated_at">[] = [
  // Personal category
  { field_key: "first_name", field_label: "First Name", field_type: "text", field_category: "personal", is_required: true, is_visible: true, is_system: true, display_order: 1, options: null, placeholder: null, help_text: null },
  { field_key: "last_name", field_label: "Last Name", field_type: "text", field_category: "personal", is_required: true, is_visible: true, is_system: true, display_order: 2, options: null, placeholder: null, help_text: null },
  { field_key: "email", field_label: "Email", field_type: "email", field_category: "personal", is_required: false, is_visible: true, is_system: true, display_order: 3, options: null, placeholder: null, help_text: null },
  { field_key: "phone", field_label: "Phone", field_type: "phone", field_category: "personal", is_required: false, is_visible: true, is_system: true, display_order: 4, options: null, placeholder: null, help_text: null },
  { field_key: "national_id", field_label: "National ID", field_type: "text", field_category: "personal", is_required: false, is_visible: true, is_system: true, display_order: 5, options: null, placeholder: null, help_text: null },
  
  // Employment category
  { field_key: "hire_date", field_label: "Hire Date", field_type: "date", field_category: "employment", is_required: true, is_visible: true, is_system: true, display_order: 1, options: null, placeholder: null, help_text: null },
  { field_key: "employment_type", field_label: "Employment Type", field_type: "select", field_category: "employment", is_required: true, is_visible: true, is_system: true, display_order: 2, options: [{ value: "full_time", label: "Full Time" }, { value: "part_time", label: "Part Time" }, { value: "contract", label: "Contract" }, { value: "intern", label: "Intern" }], placeholder: null, help_text: null },
  { field_key: "department", field_label: "Department", field_type: "text", field_category: "employment", is_required: false, is_visible: true, is_system: true, display_order: 3, options: null, placeholder: null, help_text: null },
  { field_key: "position", field_label: "Position", field_type: "text", field_category: "employment", is_required: false, is_visible: true, is_system: true, display_order: 4, options: null, placeholder: null, help_text: null },
  
  // Statutory identifiers MOVED to pack_requirements (the localization
  // pack publishes them per-business). Do NOT add hardcoded statutory
  // entries here — they would re-leak country-specific fields into
  // every org's Add-Employee form. See useEmployeeRequirements.

  // Banking category
  { field_key: "bank_name", field_label: "Bank Name", field_type: "text", field_category: "banking", is_required: false, is_visible: true, is_system: true, display_order: 1, options: null, placeholder: null, help_text: null },
  { field_key: "bank_branch", field_label: "Branch", field_type: "text", field_category: "banking", is_required: false, is_visible: true, is_system: true, display_order: 2, options: null, placeholder: null, help_text: null },
  { field_key: "bank_account_number", field_label: "Account Number", field_type: "text", field_category: "banking", is_required: false, is_visible: true, is_system: true, display_order: 3, options: null, placeholder: null, help_text: null },
  { field_key: "bank_code", field_label: "Bank Code", field_type: "text", field_category: "banking", is_required: false, is_visible: true, is_system: true, display_order: 4, options: null, placeholder: null, help_text: null },
];

export function useEmployeeFields() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const [fieldConfigs, setFieldConfigs] = useState<EmployeeFieldConfig[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchFieldConfigs = useCallback(async () => {
    if (!currentOrg?.id || !currentBusiness?.id) return;
    setIsLoading(true);

    try {
      const { data, error } = await supabase
        .from("employee_field_configs")
        .select("*")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .order("field_category")
        .order("display_order");

      if (error) throw error;
      
      // If no configs exist, return default fields (they'll be visible but not stored yet)
      if (!data || data.length === 0) {
        // Cast defaults to match expected type
        const defaultsWithMeta = DEFAULT_EMPLOYEE_FIELDS.map((field, index) => ({
          ...field,
          id: `default-${index}`,
          organization_id: currentOrg.id,
        business_id: currentBusiness.id,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })) as EmployeeFieldConfig[];
        setFieldConfigs(defaultsWithMeta);
      } else {
        setFieldConfigs(data as unknown as EmployeeFieldConfig[]);
      }
    } catch (error) {
      console.error("Error fetching employee field configs:", error);
      toast.error("Failed to fetch field configurations");
    } finally {
      setIsLoading(false);
    }
  }, [currentOrg?.id, currentBusiness?.id]);

  useEffect(() => {
    fetchFieldConfigs();
  }, [fetchFieldConfigs]);

  const saveFieldConfig = async (config: Omit<EmployeeFieldConfig, "id" | "created_at" | "updated_at">) => {
    if (!currentOrg) throw new Error("No organization selected");

    const { data, error } = await supabase
      .from("employee_field_configs")
      .upsert({
        ...config,
        organization_id: currentOrg.id,
        business_id: currentBusiness.id,
      }, {
        onConflict: "organization_id,field_key",
      })
      .select()
      .single();

    if (error) throw error;
    
    await fetchFieldConfigs();
    return data;
  };

  const updateFieldConfig = async (id: string, updates: Partial<EmployeeFieldConfig>) => {
    const { error } = await supabase
      .from("employee_field_configs")
      .update(updates)
      .eq("id", id);

    if (error) throw error;
    
    toast.success("Field configuration updated");
    await fetchFieldConfigs();
  };

  const deleteFieldConfig = async (id: string) => {
    const { error } = await supabase
      .from("employee_field_configs")
      .delete()
      .eq("id", id);

    if (error) throw error;
    
    toast.success("Custom field deleted");
    await fetchFieldConfigs();
  };

  const addCustomField = async (
    fieldLabel: string,
    fieldType: EmployeeFieldConfig["field_type"] = "text",
    category: EmployeeFieldConfig["field_category"] = "custom"
  ) => {
    if (!currentOrg) throw new Error("No organization selected");

    const fieldKey = `custom_${fieldLabel.toLowerCase().replace(/\s+/g, "_")}_${Date.now()}`;
    
    // Get highest display order for the category
    const categoryFields = fieldConfigs.filter(f => f.field_category === category);
    const maxOrder = categoryFields.length > 0 
      ? Math.max(...categoryFields.map(f => f.display_order)) 
      : 0;

    const { data, error } = await supabase
      .from("employee_field_configs")
      .insert({
        organization_id: currentOrg.id,
        business_id: currentBusiness.id,
        field_key: fieldKey,
        field_label: fieldLabel,
        field_type: fieldType,
        field_category: category,
        is_required: false,
        is_visible: true,
        is_system: false,
        display_order: maxOrder + 1,
      })
      .select()
      .single();

    if (error) throw error;
    
    toast.success(`Custom field "${fieldLabel}" added`);
    await fetchFieldConfigs();
    return data;
  };

  const initializeDefaultFields = async () => {
    if (!currentOrg) throw new Error("No organization selected");

    const fieldsToInsert = DEFAULT_EMPLOYEE_FIELDS.map(field => ({
      ...field,
      organization_id: currentOrg.id,
        business_id: currentBusiness.id,
    }));

    const { error } = await supabase
      .from("employee_field_configs")
      .upsert(fieldsToInsert, {
        onConflict: "organization_id,field_key",
      });

    if (error) throw error;
    
    await fetchFieldConfigs();
    toast.success("Default field configurations initialized");
  };

  // Get fields grouped by category
  const getFieldsByCategory = (category: EmployeeFieldConfig["field_category"]) => {
    return fieldConfigs
      .filter(f => f.field_category === category && f.is_visible)
      .sort((a, b) => a.display_order - b.display_order);
  };

  return {
    fieldConfigs,
    isLoading,
    saveFieldConfig,
    updateFieldConfig,
    deleteFieldConfig,
    addCustomField,
    initializeDefaultFields,
    getFieldsByCategory,
    refreshFieldConfigs: fetchFieldConfigs,
    personalFields: getFieldsByCategory("personal"),
    employmentFields: getFieldsByCategory("employment"),
    statutoryFields: getFieldsByCategory("statutory"),
    bankingFields: getFieldsByCategory("banking"),
    customFields: getFieldsByCategory("custom"),
  };
}

// Hook for managing custom field values for a specific employee
export function useEmployeeCustomFields(employeeId: string | null) {
  const [customFields, setCustomFields] = useState<EmployeeCustomField[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const fetchCustomFields = useCallback(async () => {
    if (!employeeId) return;
    setIsLoading(true);

    try {
      const { data, error } = await supabase
        .from("employee_custom_fields")
        .select("*")
        .eq("employee_id", employeeId);

      if (error) throw error;
      setCustomFields((data || []) as unknown as EmployeeCustomField[]);
    } catch (error) {
      console.error("Error fetching custom fields:", error);
    } finally {
      setIsLoading(false);
    }
  }, [employeeId]);

  useEffect(() => {
    fetchCustomFields();
  }, [fetchCustomFields]);

  const saveCustomFieldValue = async (fieldKey: string, fieldValue: string | null) => {
    if (!employeeId) throw new Error("No employee selected");

    const { error } = await supabase
      .from("employee_custom_fields")
      .upsert({
        employee_id: employeeId,
        field_key: fieldKey,
        field_value: fieldValue,
      }, {
        onConflict: "employee_id,field_key",
      });

    if (error) throw error;
    await fetchCustomFields();
  };

  const getFieldValue = (fieldKey: string): string | null => {
    const field = customFields.find(f => f.field_key === fieldKey);
    return field?.field_value ?? null;
  };

  return {
    customFields,
    isLoading,
    saveCustomFieldValue,
    getFieldValue,
    refreshCustomFields: fetchCustomFields,
  };
}
