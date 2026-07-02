import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { toast } from "sonner";
import { EntityType } from "./useEntityFields";

export interface FormTab {
  id: string;
  label: string;
  icon?: string;
  groups: string[];
}

export interface FormGroup {
  id: string;
  label: string;
  columns: 1 | 2 | 3 | 4;
  fields: string[];
  collapsible?: boolean;
  defaultCollapsed?: boolean;
}

export interface FieldOverride {
  label?: string;
  width?: "quarter" | "third" | "half" | "two-thirds" | "three-quarters" | "full";
  hidden?: boolean;
  readonly?: boolean;
}

export interface LayoutConfig {
  tabs?: FormTab[];
  groups: FormGroup[];
  field_overrides: Record<string, FieldOverride>;
}

export interface FormLayout {
  id: string;
  organization_id: string;
  entity_type: EntityType | string;
  layout_name: string;
  is_default: boolean;
  layout_config: LayoutConfig;
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

export interface ConditionalRule {
  id: string;
  form_layout_id: string;
  field_key: string;
  rule_type: "visibility" | "required" | "readonly" | "value";
  condition_expression: {
    field: string;
    operator: "=" | "!=" | ">" | "<" | ">=" | "<=" | "contains" | "not_contains" | "is_empty" | "is_not_empty";
    value?: string | number | boolean;
  };
  action_value: string | null;
  created_at: string;
}

/**
 * Hook for managing form layouts
 */
export function useFormLayouts(entityType: EntityType | string) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const [layouts, setLayouts] = useState<FormLayout[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [activeLayout, setActiveLayout] = useState<FormLayout | null>(null);

  const fetchLayouts = useCallback(async () => {
    if (!currentOrg) return;
    setIsLoading(true);

    try {
      const { data, error } = await supabase
        .from("form_layouts")
        .select("*")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .eq("entity_type", entityType)
        .order("is_default", { ascending: false })
        .order("layout_name");

      if (error) throw error;
      
      const layoutsData = (data || []) as unknown as FormLayout[];
      setLayouts(layoutsData);

      // Set active layout to default if exists
      if (!activeLayout) {
        const defaultLayout = layoutsData.find(l => l.is_default);
        if (defaultLayout) {
          setActiveLayout(defaultLayout);
        }
      }
    } catch (error) {
      console.error("Error fetching form layouts:", error);
      toast.error("Failed to fetch form layouts");
    } finally {
      setIsLoading(false);
    }
  }, [currentOrg?.id, entityType, activeLayout]);

  useEffect(() => {
    fetchLayouts();
  }, [fetchLayouts]);

  const createLayout = async (
    layoutName: string,
    layoutConfig: LayoutConfig,
    isDefault: boolean = false
  ) => {
    if (!currentOrg) throw new Error("No organization selected");

    if (isDefault) {
      await supabase
        .from("form_layouts")
        .update({ is_default: false })
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .eq("entity_type", entityType);
    }

    const { data, error } = await supabase
      .from("form_layouts")
      .insert({
        organization_id: currentOrg.id,
        business_id: currentBusiness.id,
        entity_type: entityType,
        layout_name: layoutName,
        layout_config: layoutConfig as any,
        is_default: isDefault,
      } as any)
      .select()
      .single();

    if (error) throw error;
    
    toast.success(`Form layout "${layoutName}" created`);
    await fetchLayouts();
    return data as unknown as FormLayout;
  };

  const updateLayout = async (id: string, updates: Partial<FormLayout>) => {
    if (!currentOrg) throw new Error("No organization selected");

    if (updates.is_default) {
      await supabase
        .from("form_layouts")
        .update({ is_default: false })
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .eq("entity_type", entityType);
    }

    const { error } = await supabase
      .from("form_layouts")
      .update(updates as any)
      .eq("id", id);

    if (error) throw error;
    
    toast.success("Form layout updated");
    await fetchLayouts();

    // Update active layout if it was the one updated
    if (activeLayout?.id === id) {
      setActiveLayout(prev => prev ? { ...prev, ...updates } : null);
    }
  };

  const deleteLayout = async (id: string) => {
    const { error } = await supabase
      .from("form_layouts")
      .delete()
      .eq("id", id);

    if (error) throw error;
    
    toast.success("Form layout deleted");
    
    // Clear active layout if it was deleted
    if (activeLayout?.id === id) {
      setActiveLayout(null);
    }
    
    await fetchLayouts();
  };

  const duplicateLayout = async (id: string) => {
    const layout = layouts.find(l => l.id === id);
    if (!layout) throw new Error("Layout not found");

    return createLayout(
      `${layout.layout_name} (Copy)`,
      layout.layout_config,
      false
    );
  };

  const setAsDefault = async (id: string) => {
    await updateLayout(id, { is_default: true });
  };

  return {
    layouts,
    isLoading,
    activeLayout,
    setActiveLayout,
    createLayout,
    updateLayout,
    deleteLayout,
    duplicateLayout,
    setAsDefault,
    refreshLayouts: fetchLayouts,
    defaultLayout: layouts.find(l => l.is_default),
  };
}

/**
 * Hook for managing form conditional rules
 */
export function useFormConditionalRules(formLayoutId: string | null) {
  const [rules, setRules] = useState<ConditionalRule[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const fetchRules = useCallback(async () => {
    if (!formLayoutId) return;
    setIsLoading(true);

    try {
      const { data, error } = await supabase
        .from("form_conditional_rules")
        .select("*")
        .eq("form_layout_id", formLayoutId)
        .order("field_key");

      if (error) throw error;
      setRules((data || []) as unknown as ConditionalRule[]);
    } catch (error) {
      console.error("Error fetching conditional rules:", error);
    } finally {
      setIsLoading(false);
    }
  }, [formLayoutId]);

  useEffect(() => {
    fetchRules();
  }, [fetchRules]);

  const addRule = async (rule: Omit<ConditionalRule, "id" | "created_at">) => {
    const { data, error } = await supabase
      .from("form_conditional_rules")
      .insert(rule)
      .select()
      .single();

    if (error) throw error;
    
    toast.success("Conditional rule added");
    await fetchRules();
    return data as unknown as ConditionalRule;
  };

  const deleteRule = async (id: string) => {
    const { error } = await supabase
      .from("form_conditional_rules")
      .delete()
      .eq("id", id);

    if (error) throw error;
    
    toast.success("Conditional rule deleted");
    await fetchRules();
  };

  // Get rules for a specific field
  const getRulesForField = (fieldKey: string) => {
    return rules.filter(r => r.field_key === fieldKey);
  };

  // Evaluate rules based on current form values
  const evaluateRules = (formValues: Record<string, any>) => {
    const results: Record<string, { visible: boolean; required: boolean; readonly: boolean; value?: any }> = {};

    for (const rule of rules) {
      const { field_key, rule_type, condition_expression, action_value } = rule;
      const { field, operator, value } = condition_expression;
      
      const currentValue = formValues[field];
      let conditionMet = false;

      switch (operator) {
        case "=":
          conditionMet = currentValue === value;
          break;
        case "!=":
          conditionMet = currentValue !== value;
          break;
        case ">":
          conditionMet = Number(currentValue) > Number(value);
          break;
        case "<":
          conditionMet = Number(currentValue) < Number(value);
          break;
        case ">=":
          conditionMet = Number(currentValue) >= Number(value);
          break;
        case "<=":
          conditionMet = Number(currentValue) <= Number(value);
          break;
        case "contains":
          conditionMet = String(currentValue).includes(String(value));
          break;
        case "not_contains":
          conditionMet = !String(currentValue).includes(String(value));
          break;
        case "is_empty":
          conditionMet = currentValue == null || currentValue === "";
          break;
        case "is_not_empty":
          conditionMet = currentValue != null && currentValue !== "";
          break;
      }

      if (!results[field_key]) {
        results[field_key] = { visible: true, required: false, readonly: false };
      }

      if (conditionMet) {
        switch (rule_type) {
          case "visibility":
            results[field_key].visible = action_value !== "hide";
            break;
          case "required":
            results[field_key].required = true;
            break;
          case "readonly":
            results[field_key].readonly = true;
            break;
          case "value":
            results[field_key].value = action_value;
            break;
        }
      }
    }

    return results;
  };

  return {
    rules,
    isLoading,
    addRule,
    deleteRule,
    getRulesForField,
    evaluateRules,
    refreshRules: fetchRules,
  };
}
