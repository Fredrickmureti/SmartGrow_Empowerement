/**
 * Core Fields Manager
 * 
 * Allows org admins to hide, reorder, and relabel built-in entity fields.
 * Part of Studio's field customization capabilities.
 */

import { useState, useMemo } from "react";
import { useCoreFieldOverrides } from "@/hooks/useCoreFieldOverrides";
import { EntityType, ENTITY_TYPE_LABELS } from "@/hooks/useEntityFields";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { toast } from "sonner";
import {
  Eye,
  EyeOff,
  Save,
  RotateCcw,
  ShieldAlert,
  GripVertical,
  Tag,
  Loader2,
} from "lucide-react";

// Core fields per entity type (same as ViewConfigPanel)
const CORE_FIELDS: Record<string, { field: string; label: string; protected?: boolean }[]> = {
  contact: [
    { field: "name", label: "Name", protected: true },
    { field: "email", label: "Email" },
    { field: "phone", label: "Phone" },
    { field: "type", label: "Type" },
    { field: "company_name", label: "Company" },
    { field: "status", label: "Status" },
    { field: "tax_id", label: "Tax ID" },
    { field: "website", label: "Website" },
    { field: "notes", label: "Notes" },
    { field: "created_at", label: "Created At" },
  ],
  invoice: [
    { field: "invoice_number", label: "Invoice #", protected: true },
    { field: "contact_name", label: "Customer", protected: true },
    { field: "status", label: "Status", protected: true },
    { field: "total_amount", label: "Total", protected: true },
    { field: "tax_amount", label: "Tax Amount", protected: true },
    { field: "due_date", label: "Due Date" },
    { field: "issue_date", label: "Issue Date" },
    { field: "payment_terms", label: "Payment Terms" },
    { field: "reference", label: "Reference" },
    { field: "notes", label: "Notes" },
  ],
  estimate: [
    { field: "estimate_number", label: "Estimate #", protected: true },
    { field: "contact_name", label: "Customer", protected: true },
    { field: "status", label: "Status", protected: true },
    { field: "total_amount", label: "Total", protected: true },
    { field: "valid_until", label: "Valid Until" },
    { field: "notes", label: "Notes" },
  ],
  product: [
    { field: "name", label: "Name", protected: true },
    { field: "sku", label: "SKU" },
    { field: "type", label: "Type" },
    { field: "price", label: "Price", protected: true },
    { field: "cost", label: "Cost" },
    { field: "category", label: "Category" },
    { field: "status", label: "Status" },
    { field: "description", label: "Description" },
    { field: "barcode", label: "Barcode" },
  ],
  sales_order: [
    { field: "order_number", label: "Order #", protected: true },
    { field: "contact_name", label: "Customer", protected: true },
    { field: "status", label: "Status", protected: true },
    { field: "total_amount", label: "Total", protected: true },
    { field: "order_date", label: "Order Date" },
    { field: "delivery_date", label: "Delivery Date" },
    { field: "notes", label: "Notes" },
  ],
  purchase_order: [
    { field: "order_number", label: "PO #", protected: true },
    { field: "vendor_name", label: "Vendor", protected: true },
    { field: "status", label: "Status", protected: true },
    { field: "total_amount", label: "Total", protected: true },
    { field: "order_date", label: "Order Date" },
    { field: "expected_date", label: "Expected Date" },
    { field: "notes", label: "Notes" },
  ],
  bill: [
    { field: "bill_number", label: "Bill #", protected: true },
    { field: "vendor_name", label: "Vendor", protected: true },
    { field: "status", label: "Status", protected: true },
    { field: "total_amount", label: "Total", protected: true },
    { field: "due_date", label: "Due Date" },
    { field: "notes", label: "Notes" },
  ],
  expense: [
    { field: "description", label: "Description", protected: true },
    { field: "amount", label: "Amount", protected: true },
    { field: "category", label: "Category" },
    { field: "status", label: "Status", protected: true },
    { field: "expense_date", label: "Date" },
    { field: "merchant", label: "Merchant" },
    { field: "notes", label: "Notes" },
  ],
  crm_lead: [
    { field: "name", label: "Name", protected: true },
    { field: "contact_name", label: "Contact" },
    { field: "stage", label: "Stage", protected: true },
    { field: "expected_revenue", label: "Expected Revenue" },
    { field: "probability", label: "Probability" },
    { field: "source", label: "Source" },
    { field: "notes", label: "Notes" },
  ],
  employee: [
    { field: "name", label: "Name", protected: true },
    { field: "email", label: "Email" },
    { field: "department", label: "Department" },
    { field: "position", label: "Position" },
    { field: "status", label: "Status", protected: true },
    { field: "phone", label: "Phone" },
    { field: "hire_date", label: "Hire Date" },
  ],
  project: [
    { field: "name", label: "Name", protected: true },
    { field: "status", label: "Status", protected: true },
    { field: "start_date", label: "Start Date" },
    { field: "end_date", label: "End Date" },
    { field: "progress", label: "Progress" },
    { field: "description", label: "Description" },
  ],
};

interface FieldState {
  field: string;
  defaultLabel: string;
  isVisible: boolean;
  labelOverride: string;
  isProtected: boolean;
  displayOrder: number;
}

interface CoreFieldsManagerProps {
  entityType: EntityType;
}

export function CoreFieldsManager({ entityType }: CoreFieldsManagerProps) {
  const { overrides, isLoading, bulkUpdate } = useCoreFieldOverrides(entityType);
  const [isSaving, setIsSaving] = useState(false);

  const coreFields = CORE_FIELDS[entityType] || [];

  const [fieldStates, setFieldStates] = useState<FieldState[]>([]);
  const [hasChanges, setHasChanges] = useState(false);

  // Initialize field states from overrides + defaults
  useMemo(() => {
    const states = coreFields.map((f, index) => {
      const override = overrides.find(o => o.field_key === f.field);
      return {
        field: f.field,
        defaultLabel: f.label,
        isVisible: override ? override.is_visible : true,
        labelOverride: override?.label_override || "",
        isProtected: f.protected || false,
        displayOrder: override?.display_order ?? index,
      };
    });
    states.sort((a, b) => a.displayOrder - b.displayOrder);
    setFieldStates(states);
    setHasChanges(false);
  }, [overrides, entityType]);

  const toggleVisibility = (field: string) => {
    setFieldStates(prev =>
      prev.map(f => {
        if (f.field === field && !f.isProtected) {
          return { ...f, isVisible: !f.isVisible };
        }
        return f;
      })
    );
    setHasChanges(true);
  };

  const updateLabel = (field: string, label: string) => {
    setFieldStates(prev =>
      prev.map(f => (f.field === field ? { ...f, labelOverride: label } : f))
    );
    setHasChanges(true);
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await bulkUpdate(
        entityType,
        fieldStates.map((f, index) => ({
          field_key: f.field,
          is_visible: f.isVisible,
          display_order: index,
          label_override: f.labelOverride.trim() || null,
        }))
      );
      setHasChanges(false);
    } catch {
      // error handled in hook
    } finally {
      setIsSaving(false);
    }
  };

  const handleReset = () => {
    const states = coreFields.map((f, index) => ({
      field: f.field,
      defaultLabel: f.label,
      isVisible: true,
      labelOverride: "",
      isProtected: f.protected || false,
      displayOrder: index,
    }));
    setFieldStates(states);
    setHasChanges(true);
  };

  const hiddenCount = fieldStates.filter(f => !f.isVisible).length;
  const relabeledCount = fieldStates.filter(f => f.labelOverride.trim()).length;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <CardTitle className="text-base flex items-center gap-2">
              <Tag className="h-4 w-4 text-primary shrink-0" />
              <span className="truncate">Core Fields — {ENTITY_TYPE_LABELS[entityType]}</span>
            </CardTitle>
            <CardDescription className="text-xs mt-1">
              Show/hide and relabel built-in fields. Protected fields (marked with 🔒) cannot be hidden.
            </CardDescription>
          </div>
          {(hiddenCount > 0 || relabeledCount > 0) && (
            <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
              {hiddenCount > 0 && (
                <Badge variant="secondary" className="text-xs">
                  {hiddenCount} hidden
                </Badge>
              )}
              {relabeledCount > 0 && (
                <Badge variant="outline" className="text-xs">
                  {relabeledCount} relabeled
                </Badge>
              )}
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <Alert>
          <ShieldAlert className="h-4 w-4 text-primary" />
          <AlertDescription className="text-xs">
            Changes apply org-wide. Hidden fields are removed from forms and list views.
            Core financial and identity fields are protected and cannot be hidden.
          </AlertDescription>
        </Alert>

        <ScrollArea className="max-h-[60vh] sm:max-h-[400px]">
          <div className="space-y-1.5 pr-1">
            {fieldStates.map((field) => (
              <div
                key={field.field}
                className={`rounded-md border transition-colors ${
                  !field.isVisible ? "bg-muted/30 opacity-60" : "bg-background"
                }`}
              >
                <div className="flex flex-col gap-2 p-2.5 sm:flex-row sm:items-center sm:gap-3 sm:py-2">
                  <div className="flex items-center gap-2 min-w-0 sm:flex-1">
                    <GripVertical className="h-4 w-4 text-muted-foreground/40 shrink-0 hidden sm:block" />

                    <div className="flex items-center justify-center shrink-0 w-9">
                      {field.isProtected ? (
                        <span className="text-sm" title="Protected — cannot be hidden">
                          🔒
                        </span>
                      ) : (
                        <Switch
                          checked={field.isVisible}
                          onCheckedChange={() => toggleVisibility(field.field)}
                          aria-label={`Toggle ${field.defaultLabel}`}
                        />
                      )}
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium truncate">{field.defaultLabel}</span>
                        {!field.isVisible && (
                          <EyeOff className="h-3 w-3 text-muted-foreground shrink-0" />
                        )}
                      </div>
                      <span className="text-xs text-muted-foreground font-mono truncate block">
                        {field.field}
                      </span>
                    </div>
                  </div>

                  <div className="w-full sm:w-40 sm:shrink-0">
                    <Input
                      value={field.labelOverride}
                      onChange={(e) => updateLabel(field.field, e.target.value)}
                      placeholder={field.defaultLabel}
                      className="h-8 text-xs"
                      disabled={!field.isVisible}
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </ScrollArea>

        <Separator />

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
          <Button
            variant="outline"
            size="sm"
            onClick={handleReset}
            disabled={isSaving}
            className="w-full sm:w-auto"
          >
            <RotateCcw className="h-3.5 w-3.5 mr-1" />
            Reset All
          </Button>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={!hasChanges || isSaving}
            className="w-full sm:w-auto"
          >
            {isSaving ? (
              <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5 mr-1" />
            )}
            Save Changes
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
