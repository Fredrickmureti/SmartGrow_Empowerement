import { useEffect, useState, useCallback, useRef, useImperativeHandle, forwardRef } from "react";
import { useEntityFields, useEntityFieldValues, EntityType, EntityFieldConfig, ConditionalVisibility } from "@/hooks/useEntityFields";
import { useDebouncedCallback } from "@/hooks/useDebouncedCallback";
import { useFormLayouts, type FormGroup } from "@/hooks/useFormLayouts";
import { CustomFieldRenderer } from "./CustomFieldRenderer";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Settings2, ExternalLink, ChevronDown } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export interface CustomFieldValidationError {
  fieldKey: string;
  fieldLabel: string;
  message: string;
}

export interface CustomFieldsSectionHandle {
  validate: () => CustomFieldValidationError[];
}

interface CustomFieldsSectionProps {
  entityType: EntityType;
  entityId: string | null;
  formValues?: Record<string, any>;
  onChange?: (fieldKey: string, value: string | null, valueJson?: Record<string, any> | null) => void;
  disabled?: boolean;
  showHeader?: boolean;
  className?: string;
  /** Filter fields by document_section. If not set, shows all fields. */
  documentSection?: string | string[];
  /** Read-only mode for detail/profile views */
  readOnly?: boolean;
}

/**
 * CustomFieldsSection - Renders all custom fields for an entity type
 * 
 * Now layout-aware: if a default form layout exists for the entity type,
 * fields are arranged according to the layout's tabs, groups, columns,
 * collapsible sections, and field overrides. Otherwise falls back to
 * the original field_group-based 2-column grid.
 */
export const CustomFieldsSection = forwardRef<CustomFieldsSectionHandle, CustomFieldsSectionProps>(function CustomFieldsSection({
  entityType,
  entityId,
  formValues = {},
  onChange,
  disabled = false,
  showHeader = true,
  className,
  documentSection,
  readOnly = false,
}, ref) {
  const navigate = useNavigate();
  const { visibleFields, isLoading: fieldsLoading } = useEntityFields(entityType);
  const { defaultLayout, isLoading: layoutsLoading } = useFormLayouts(entityType);
  const { 
    getFieldValue, 
    getFieldValueJson, 
    saveFieldValue,
    isLoading: valuesLoading 
  } = useEntityFieldValues(entityType, entityId);
  
  const [localValues, setLocalValues] = useState<Record<string, { value: string | null; valueJson?: Record<string, any> | null }>>({});
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});
  const isInitializedRef = useRef(false);
  const pendingSavesRef = useRef<Map<string, { field: EntityFieldConfig; value: string | null; valueJson?: Record<string, any> | null }>>(new Map());

  // Initialize local values from DB when editing - only once when data first loads
  useEffect(() => {
    if (entityId && !valuesLoading && visibleFields.length > 0 && !isInitializedRef.current) {
      const values: Record<string, { value: string | null; valueJson?: Record<string, any> | null }> = {};
      visibleFields.forEach(field => {
        values[field.field_key] = {
          value: getFieldValue(field.field_key),
          valueJson: getFieldValueJson(field.field_key),
        };
      });
      setLocalValues(values);
      isInitializedRef.current = true;
    }
  }, [entityId, valuesLoading, visibleFields, getFieldValue, getFieldValueJson]);

  // Apply default values in create mode (no entityId) when fields load
  useEffect(() => {
    if (!entityId && visibleFields.length > 0 && !isInitializedRef.current) {
      const defaults: Record<string, { value: string | null; valueJson?: Record<string, any> | null }> = {};
      let hasDefaults = false;
      visibleFields.forEach(field => {
        if (field.default_value && !formValues[field.field_key]) {
          defaults[field.field_key] = { value: field.default_value };
          hasDefaults = true;
          if (onChange) {
            onChange(field.field_key, field.default_value);
          }
        }
      });
      if (hasDefaults) {
        setLocalValues(prev => ({ ...prev, ...defaults }));
      }
      isInitializedRef.current = true;
    }
  }, [entityId, visibleFields, formValues, onChange]);

  // Reset initialization flag when entityId changes
  useEffect(() => {
    isInitializedRef.current = false;
  }, [entityId]);

  // Validate all visible fields - exposed via ref
  const validate = useCallback((): CustomFieldValidationError[] => {
    const errors: CustomFieldValidationError[] = [];
    const newValidationErrors: Record<string, string> = {};

    const sectionFilteredFields = documentSection
      ? visibleFields.filter(f => {
          const fieldSection = f.document_section || "additional";
          if (Array.isArray(documentSection)) return documentSection.includes(fieldSection);
          return fieldSection === documentSection;
        })
      : visibleFields;

    const filtered = sectionFilteredFields.filter(evaluateVisibility);

    for (const field of filtered) {
      const val = getValue(field.field_key);

      if (field.is_required && (!val || val.trim() === "")) {
        const msg = `${field.field_label} is required`;
        errors.push({ fieldKey: field.field_key, fieldLabel: field.field_label, message: msg });
        newValidationErrors[field.field_key] = msg;
        continue;
      }

      if (val && field.validation_rules?.regex) {
        try {
          const re = new RegExp(field.validation_rules.regex);
          if (!re.test(val)) {
            const msg = field.validation_rules.message || `${field.field_label} format is invalid`;
            errors.push({ fieldKey: field.field_key, fieldLabel: field.field_label, message: msg });
            newValidationErrors[field.field_key] = msg;
          }
        } catch {
          // Invalid regex pattern, skip validation
        }
      }

      if (val && field.field_type === "number") {
        const num = Number(val);
        if (field.validation_rules?.min !== undefined && num < field.validation_rules.min) {
          const msg = `${field.field_label} must be at least ${field.validation_rules.min}`;
          errors.push({ fieldKey: field.field_key, fieldLabel: field.field_label, message: msg });
          newValidationErrors[field.field_key] = msg;
        }
        if (field.validation_rules?.max !== undefined && num > field.validation_rules.max) {
          const msg = `${field.field_label} must be at most ${field.validation_rules.max}`;
          errors.push({ fieldKey: field.field_key, fieldLabel: field.field_label, message: msg });
          newValidationErrors[field.field_key] = msg;
        }
      }
    }

    setValidationErrors(newValidationErrors);
    return errors;
  }, [visibleFields, documentSection]);

  useImperativeHandle(ref, () => ({ validate }), [validate]);

  // Debounced save function
  const debouncedSave = useDebouncedCallback(async () => {
    if (!entityId || pendingSavesRef.current.size === 0) return;
    
    const saves = Array.from(pendingSavesRef.current.values());
    pendingSavesRef.current.clear();
    
    for (const { field, value, valueJson } of saves) {
      try {
        await saveFieldValue(field.id, field.field_key, value, valueJson);
      } catch (error) {
        console.error("Failed to save field value:", error);
      }
    }
  }, 500);

  // Evaluate conditional visibility
  const evaluateVisibility = useCallback((field: EntityFieldConfig): boolean => {
    if (!field.conditional_visibility) return true;
    
    const condition = field.conditional_visibility as ConditionalVisibility;
    const targetValue = formValues[condition.field] ?? localValues[condition.field]?.value;
    
    switch (condition.operator) {
      case "=": return targetValue == condition.value;
      case "!=": return targetValue != condition.value;
      case ">": return Number(targetValue) > Number(condition.value);
      case "<": return Number(targetValue) < Number(condition.value);
      case ">=": return Number(targetValue) >= Number(condition.value);
      case "<=": return Number(targetValue) <= Number(condition.value);
      case "contains": return String(targetValue || "").includes(String(condition.value));
      case "not_contains": return !String(targetValue || "").includes(String(condition.value));
      case "is_empty": return !targetValue || targetValue === "";
      case "is_not_empty": return !!targetValue && targetValue !== "";
      default: return true;
    }
  }, [formValues, localValues]);

  const handleChange = (
    field: EntityFieldConfig,
    value: string | null,
    valueJson?: Record<string, any> | null
  ) => {
    if (validationErrors[field.field_key]) {
      setValidationErrors(prev => {
        const next = { ...prev };
        delete next[field.field_key];
        return next;
      });
    }

    setLocalValues(prev => ({
      ...prev,
      [field.field_key]: { value, valueJson },
    }));

    if (!entityId && onChange) {
      onChange(field.field_key, value, valueJson);
      return;
    }

    if (entityId) {
      pendingSavesRef.current.set(field.field_key, { field, value, valueJson });
      debouncedSave();
    }
  };

  const getValue = (fieldKey: string): string | null => {
    if (!entityId && formValues[fieldKey] !== undefined) {
      return formValues[fieldKey];
    }
    return localValues[fieldKey]?.value ?? null;
  };

  const getValueJson = (fieldKey: string): Record<string, any> | null => {
    return localValues[fieldKey]?.valueJson ?? null;
  };

  // Filter by document section if specified
  const sectionFilteredFields = documentSection
    ? visibleFields.filter(f => {
        const fieldSection = f.document_section || "additional";
        if (Array.isArray(documentSection)) {
          return documentSection.includes(fieldSection);
        }
        return fieldSection === documentSection;
      })
    : visibleFields;

  const filteredFields = sectionFilteredFields.filter(evaluateVisibility);

  if (fieldsLoading || layoutsLoading) {
    return (
      <div className={className}>
        {showHeader && (
          <>
            <div className="flex items-center gap-2 text-sm text-muted-foreground mb-4">
              <Settings2 className="h-4 w-4" />
              <span>Custom Fields</span>
            </div>
            <Separator className="mb-4" />
          </>
        )}
        <div className="grid gap-4 md:grid-cols-2">
          {[1, 2].map((i) => (
            <div key={i} className="space-y-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-10 w-full" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (filteredFields.length === 0) {
    return null;
  }

  const isDisabled = disabled || readOnly;
  const fieldMap = new Map(filteredFields.map(f => [f.field_key, f]));

  const renderField = (field: EntityFieldConfig, widthClass?: string) => (
    <div key={field.id} className={widthClass}>
      <CustomFieldRenderer
        field={field}
        value={getValue(field.field_key)}
        valueJson={getValueJson(field.field_key)}
        onChange={(value, valueJson) => handleChange(field, value, valueJson)}
        disabled={isDisabled || field.field_type === "computed"}
      />
      {validationErrors[field.field_key] && (
        <p className="text-xs text-destructive mt-1">{validationErrors[field.field_key]}</p>
      )}
    </div>
  );

  const widthToClass: Record<string, string> = {
    quarter: "md:col-span-1",
    third: "md:col-span-1",
    half: "md:col-span-1",
    "two-thirds": "md:col-span-2",
    "three-quarters": "md:col-span-2",
    full: "md:col-span-2",
  };

  const layoutConfig = defaultLayout?.layout_config;
  const hasLayout = layoutConfig && layoutConfig.groups && layoutConfig.groups.length > 0;

  const renderGroup = (group: FormGroup) => {
    const groupFields = group.fields
      .map(fk => fieldMap.get(fk))
      .filter((f): f is EntityFieldConfig => !!f && evaluateVisibility(f));

    if (groupFields.length === 0) return null;

    const cols = group.columns || 2;
    const gridClass = cols === 1 ? "grid gap-4 grid-cols-1"
      : cols === 3 ? "grid gap-4 md:grid-cols-3"
      : cols === 4 ? "grid gap-4 md:grid-cols-4"
      : "grid gap-4 md:grid-cols-2";

    const overrides = layoutConfig?.field_overrides || {};

    const content = (
      <div className={gridClass}>
        {groupFields.map(field => {
          const override = overrides[field.field_key];
          if (override?.hidden) return null;
          const wClass = override?.width ? widthToClass[override.width] : undefined;
          return renderField(field, wClass);
        })}
      </div>
    );

    if (group.collapsible) {
      return (
        <Collapsible key={group.id} defaultOpen={!group.defaultCollapsed}>
          <CollapsibleTrigger className="flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground w-full py-1">
            <ChevronDown className="h-4 w-4 transition-transform duration-200" />
            {group.label}
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-3">
            {content}
          </CollapsibleContent>
        </Collapsible>
      );
    }

    return (
      <div key={group.id} className="space-y-3">
        {group.label && (
          <h4 className="text-sm font-medium text-muted-foreground">{group.label}</h4>
        )}
        {content}
      </div>
    );
  };

  const renderBody = () => {
    if (hasLayout && layoutConfig.tabs && layoutConfig.tabs.length > 0) {
      return (
        <Tabs defaultValue={layoutConfig.tabs[0].id} className="w-full">
          <TabsList className="mb-4">
            {layoutConfig.tabs.map(tab => (
              <TabsTrigger key={tab.id} value={tab.id}>{tab.label}</TabsTrigger>
            ))}
          </TabsList>
          {layoutConfig.tabs.map(tab => {
            const tabGroups = layoutConfig.groups.filter(g => tab.groups.includes(g.id));
            return (
              <TabsContent key={tab.id} value={tab.id} className="space-y-6">
                {tabGroups.map(g => renderGroup(g))}
              </TabsContent>
            );
          })}
        </Tabs>
      );
    }

    if (hasLayout) {
      return (
        <div className="space-y-6">
          {layoutConfig.groups.map(g => renderGroup(g))}
          {(() => {
            const assignedKeys = new Set(layoutConfig.groups.flatMap(g => g.fields));
            const unassigned = filteredFields.filter(f => !assignedKeys.has(f.field_key));
            if (unassigned.length === 0) return null;
            return (
              <div className="grid gap-4 md:grid-cols-2">
                {unassigned.map(field => renderField(field))}
              </div>
            );
          })()}
        </div>
      );
    }

    // Default: group by field_group (original behavior when no layout exists)
    const groupedFields = filteredFields.reduce((acc, field) => {
      const group = field.field_group || "_default";
      if (!acc[group]) acc[group] = [];
      acc[group].push(field);
      return acc;
    }, {} as Record<string, EntityFieldConfig[]>);

    const fieldGroups = Object.keys(groupedFields).sort((a, b) => {
      if (a === "_default") return 1;
      if (b === "_default") return -1;
      return a.localeCompare(b);
    });

    return (
      <>
        {fieldGroups.map((group) => (
          <div key={group} className="space-y-4">
            {group !== "_default" && (
              <h4 className="text-sm font-medium text-muted-foreground">{group}</h4>
            )}
            <div className="grid gap-4 md:grid-cols-2">
              {groupedFields[group].map((field) => renderField(field))}
            </div>
          </div>
        ))}
      </>
    );
  };

  return (
    <div className={className}>
      {showHeader && (
        <>
          <div className="flex items-center justify-between text-sm text-muted-foreground mb-4">
            <div className="flex items-center gap-2">
              <Settings2 className="h-4 w-4" />
              <span>Custom Fields</span>
            </div>
            {!readOnly && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    onClick={() => navigate(`/studio?entity=${entityType}`)}
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Manage fields in Studio</TooltipContent>
              </Tooltip>
            )}
          </div>
          <Separator className="mb-4" />
        </>
      )}
      {renderBody()}
    </div>
  );
});

/**
 * Hook to collect custom field values for form submission
 */
export function useCustomFieldFormState(entityType: EntityType) {
  const [customFieldValues, setCustomFieldValues] = useState<Record<string, { value: string | null; valueJson?: Record<string, any> | null }>>({});
  const { visibleFields } = useEntityFields(entityType);

  const handleCustomFieldChange = (
    fieldKey: string,
    value: string | null,
    valueJson?: Record<string, any> | null
  ) => {
    setCustomFieldValues(prev => ({
      ...prev,
      [fieldKey]: { value, valueJson },
    }));
  };

  const getCustomFieldsForSubmit = () => {
    return Object.entries(customFieldValues).map(([fieldKey, data]) => {
      const field = visibleFields.find(f => f.field_key === fieldKey);
      return {
        fieldConfigId: field?.id || "",
        fieldKey,
        value: data.value,
        valueJson: data.valueJson,
      };
    }).filter(item => item.fieldConfigId);
  };

  const resetCustomFields = () => {
    setCustomFieldValues({});
  };

  return {
    customFieldValues,
    handleCustomFieldChange,
    getCustomFieldsForSubmit,
    resetCustomFields,
  };
}
