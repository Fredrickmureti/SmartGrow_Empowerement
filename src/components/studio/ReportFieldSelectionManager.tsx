/**
 * Studio Report Field Selection Manager
 * 
 * Allows configuring which core and custom fields appear on PDF/print exports
 * for each entity type, and in what order and sections.
 */

import { useState } from "react";
import { useReportFieldConfigs, ReportFieldConfig } from "@/hooks/useReportFieldConfigs";
import { ENTITY_TYPE_LABELS, EntityType, useEntityFields } from "@/hooks/useEntityFields";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import {
  FileText,
  Plus,
  Save,
  Trash2,
  Pencil,
  Loader2,
  GripVertical,
} from "lucide-react";

// Core fields per entity type that can appear in reports
const REPORT_CORE_FIELDS: Record<string, { field: string; label: string }[]> = {
  invoice: [
    { field: "invoice_number", label: "Invoice #" },
    { field: "contact_name", label: "Customer" },
    { field: "issue_date", label: "Issue Date" },
    { field: "due_date", label: "Due Date" },
    { field: "status", label: "Status" },
    { field: "subtotal", label: "Subtotal" },
    { field: "tax_amount", label: "Tax" },
    { field: "total_amount", label: "Total" },
    { field: "payment_terms", label: "Payment Terms" },
    { field: "reference", label: "Reference" },
    { field: "notes", label: "Notes" },
  ],
  estimate: [
    { field: "estimate_number", label: "Estimate #" },
    { field: "contact_name", label: "Customer" },
    { field: "issue_date", label: "Issue Date" },
    { field: "valid_until", label: "Valid Until" },
    { field: "status", label: "Status" },
    { field: "total_amount", label: "Total" },
    { field: "notes", label: "Notes" },
  ],
  sales_order: [
    { field: "order_number", label: "Order #" },
    { field: "contact_name", label: "Customer" },
    { field: "order_date", label: "Order Date" },
    { field: "delivery_date", label: "Delivery Date" },
    { field: "status", label: "Status" },
    { field: "total_amount", label: "Total" },
    { field: "notes", label: "Notes" },
  ],
  purchase_order: [
    { field: "order_number", label: "PO #" },
    { field: "vendor_name", label: "Vendor" },
    { field: "order_date", label: "Order Date" },
    { field: "expected_date", label: "Expected Date" },
    { field: "status", label: "Status" },
    { field: "total_amount", label: "Total" },
    { field: "notes", label: "Notes" },
  ],
  bill: [
    { field: "bill_number", label: "Bill #" },
    { field: "vendor_name", label: "Vendor" },
    { field: "bill_date", label: "Bill Date" },
    { field: "due_date", label: "Due Date" },
    { field: "status", label: "Status" },
    { field: "total_amount", label: "Total" },
    { field: "notes", label: "Notes" },
  ],
};

const REPORTABLE_ENTITIES = ["invoice", "estimate", "sales_order", "purchase_order", "bill"];

export function ReportFieldSelectionManager() {
  const [selectedEntityType, setSelectedEntityType] = useState<string>("invoice");
  const { configs, isLoading, createConfig, updateConfig, deleteConfig } = useReportFieldConfigs(selectedEntityType);
  const { fieldConfigs: customFields } = useEntityFields(selectedEntityType as EntityType);
  const [showDialog, setShowDialog] = useState(false);
  const [editingConfig, setEditingConfig] = useState<ReportFieldConfig | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const coreFields = REPORT_CORE_FIELDS[selectedEntityType] || [];
  const visibleCustomFields = customFields.filter(f => f.is_visible);

  const [configName, setConfigName] = useState("Default");
  const [selectedCoreFields, setSelectedCoreFields] = useState<string[]>([]);
  const [selectedCustomFields, setSelectedCustomFields] = useState<string[]>([]);
  const [isDefault, setIsDefault] = useState(false);

  const openCreate = () => {
    setEditingConfig(null);
    setConfigName("Default");
    setSelectedCoreFields(coreFields.map(f => f.field));
    setSelectedCustomFields([]);
    setIsDefault(false);
    setShowDialog(true);
  };

  const openEdit = (config: ReportFieldConfig) => {
    setEditingConfig(config);
    setConfigName(config.config_name);
    setSelectedCoreFields(config.included_core_fields || []);
    setSelectedCustomFields(config.included_custom_fields || []);
    setIsDefault(config.is_default);
    setShowDialog(true);
  };

  const toggleCoreField = (field: string) => {
    setSelectedCoreFields(prev =>
      prev.includes(field) ? prev.filter(f => f !== field) : [...prev, field]
    );
  };

  const toggleCustomField = (field: string) => {
    setSelectedCustomFields(prev =>
      prev.includes(field) ? prev.filter(f => f !== field) : [...prev, field]
    );
  };

  const handleSave = async () => {
    if (!configName.trim()) {
      toast.error("Config name is required");
      return;
    }

    setIsSaving(true);
    try {
      const payload: Partial<ReportFieldConfig> = {
        entity_type: selectedEntityType,
        config_name: configName,
        included_core_fields: selectedCoreFields,
        included_custom_fields: selectedCustomFields,
        field_order: [...selectedCoreFields, ...selectedCustomFields],
        is_default: isDefault,
      };

      if (editingConfig) {
        await updateConfig(editingConfig.id, payload);
      } else {
        await createConfig(payload);
      }
      setShowDialog(false);
    } catch {
      toast.error("Failed to save config");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <FileText className="h-5 w-5 text-primary" />
            Report Field Selection
          </h2>
          <p className="text-sm text-muted-foreground">
            Choose which fields appear on PDF exports for each entity type
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={selectedEntityType} onValueChange={setSelectedEntityType}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {REPORTABLE_ENTITIES.map(et => (
                <SelectItem key={et} value={et}>
                  {ENTITY_TYPE_LABELS[et as EntityType] || et}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button onClick={openCreate} size="sm">
            <Plus className="h-4 w-4 mr-1" />
            New Config
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : configs.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <FileText className="h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold mb-2">No report configs</h3>
            <p className="text-muted-foreground mb-4">
              Configure which fields appear on PDF exports for {ENTITY_TYPE_LABELS[selectedEntityType as EntityType]}.
            </p>
            <Button onClick={openCreate}>
              <Plus className="h-4 w-4 mr-2" />
              Create Config
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {configs.map((config) => (
            <Card key={config.id}>
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm">{config.config_name}</span>
                      {config.is_default && (
                        <Badge variant="secondary" className="text-xs">Default</Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {(config.included_core_fields?.length || 0) + (config.included_custom_fields?.length || 0)} fields selected
                    </p>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button variant="ghost" size="icon" onClick={() => openEdit(config)}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => deleteConfig(config.id)}>
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Create/Edit Dialog */}
      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {editingConfig ? "Edit" : "Create"} Report Field Config
            </DialogTitle>
            <DialogDescription>
              Select which fields to include on {ENTITY_TYPE_LABELS[selectedEntityType as EntityType]} PDF exports.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="flex items-center gap-4">
              <div className="flex-1">
                <Label>Config Name</Label>
                <Input
                  value={configName}
                  onChange={e => setConfigName(e.target.value)}
                  placeholder="e.g., Full Report, Summary"
                />
              </div>
              <div className="flex items-center gap-2 pt-6">
                <Checkbox
                  checked={isDefault}
                  onCheckedChange={v => setIsDefault(v === true)}
                />
                <Label className="text-sm">Default</Label>
              </div>
            </div>

            <div>
              <Label className="text-sm font-medium">Core Fields</Label>
              <ScrollArea className="max-h-[200px] mt-2">
                <div className="space-y-1">
                  {coreFields.map(field => (
                    <div key={field.field} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-muted/50">
                      <Checkbox
                        checked={selectedCoreFields.includes(field.field)}
                        onCheckedChange={() => toggleCoreField(field.field)}
                      />
                      <span className="text-sm">{field.label}</span>
                      <span className="text-xs text-muted-foreground font-mono ml-auto">{field.field}</span>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            </div>

            {visibleCustomFields.length > 0 && (
              <>
                <Separator />
                <div>
                  <Label className="text-sm font-medium">Custom Fields</Label>
                  <ScrollArea className="max-h-[150px] mt-2">
                    <div className="space-y-1">
                      {visibleCustomFields.map(field => (
                        <div key={field.field_key} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-muted/50">
                          <Checkbox
                            checked={selectedCustomFields.includes(field.field_key)}
                            onCheckedChange={() => toggleCustomField(field.field_key)}
                          />
                          <span className="text-sm">{field.field_label}</span>
                          <Badge variant="outline" className="text-[10px] ml-auto">{field.field_type}</Badge>
                        </div>
                      ))}
                    </div>
                  </ScrollArea>
                </div>
              </>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDialog(false)}>Cancel</Button>
            <Button onClick={handleSave} disabled={isSaving}>
              {isSaving && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
              <Save className="h-4 w-4 mr-1" />
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
