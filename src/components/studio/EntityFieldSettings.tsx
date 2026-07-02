import { useState } from "react";
import { 
  useEntityFields, 
  EntityFieldConfig, 
  EntityType, 
  ENTITY_TYPE_LABELS, 
  FIELD_TYPE_LABELS,
  FieldType 
} from "@/hooks/useEntityFields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import {
  Plus,
  Pencil,
  Trash2,
  Eye,
  EyeOff,
  Loader2,
  Settings2,
  X,
  MoreHorizontal,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { normalizeError } from "@/services/resilience";

// Available related models for EntityLookupWidget
const RELATED_MODEL_OPTIONS = [
  { value: "contacts", label: "Contacts" },
  { value: "products", label: "Products" },
  { value: "invoices", label: "Invoices" },
  { value: "estimates", label: "Estimates" },
  { value: "projects", label: "Projects" },
  { value: "employees", label: "Employees" },
  { value: "accounts", label: "Accounts" },
];

const RELATED_DISPLAY_FIELDS: Record<string, { value: string; label: string }[]> = {
  contacts: [
    { value: "name", label: "Name" },
    { value: "email", label: "Email" },
    { value: "phone", label: "Phone" },
  ],
  products: [
    { value: "name", label: "Name" },
    { value: "sku", label: "SKU" },
  ],
  invoices: [
    { value: "invoice_number", label: "Invoice Number" },
  ],
  estimates: [
    { value: "estimate_number", label: "Estimate Number" },
  ],
  projects: [
    { value: "name", label: "Name" },
  ],
  employees: [
    { value: "first_name", label: "First Name" },
    { value: "employee_code", label: "Employee Code" },
  ],
  accounts: [
    { value: "name", label: "Name" },
    { value: "code", label: "Code" },
  ],
};

const VISIBILITY_OPERATORS = [
  { value: "=", label: "Equals" },
  { value: "!=", label: "Not equals" },
  { value: ">", label: "Greater than" },
  { value: "<", label: "Less than" },
  { value: ">=", label: "Greater or equal" },
  { value: "<=", label: "Less or equal" },
  { value: "contains", label: "Contains" },
  { value: "not_contains", label: "Does not contain" },
  { value: "is_empty", label: "Is empty" },
  { value: "is_not_empty", label: "Is not empty" },
];

interface EntityFieldSettingsProps {
  entityType: EntityType;
  title?: string;
  description?: string;
}

export function EntityFieldSettings({ 
  entityType, 
  title = "Custom Fields",
  description = "Add and manage custom fields for this entity"
}: EntityFieldSettingsProps) {
  const {
    fieldConfigs,
    isLoading,
    addField,
    updateField,
    deleteField,
    visibleFields,
  } = useEntityFields(entityType);

  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [selectedField, setSelectedField] = useState<EntityFieldConfig | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showEditAdvanced, setShowEditAdvanced] = useState(false);

  const [newField, setNewField] = useState({
    label: "",
    type: "text" as FieldType,
    placeholder: "",
    helpText: "",
    isRequired: false,
    options: [] as { value: string; label: string }[],
    relatedModel: "",
    relatedDisplayField: "",
    fieldGroup: "",
    defaultValue: "",
    validationMin: "",
    validationMax: "",
    validationRegex: "",
    validationMessage: "",
    computationFormula: "",
    computationDependencies: [] as string[],
  });

  const [newOption, setNewOption] = useState({ value: "", label: "" });
  // Edit dialog option management
  const [editNewOption, setEditNewOption] = useState({ value: "", label: "" });

  const handleToggleVisibility = async (field: EntityFieldConfig) => {
    try {
      await updateField(field.id, { is_visible: !field.is_visible });
    } catch (error: any) {
      toast.error(normalizeError(error).message || "Failed to update field");
    }
  };

  const handleToggleRequired = async (field: EntityFieldConfig) => {
    try {
      await updateField(field.id, { is_required: !field.is_required });
    } catch (error: any) {
      toast.error(normalizeError(error).message || "Failed to update field");
    }
  };


  const handleAddField = async () => {
    if (!newField.label.trim()) {
      toast.error("Field label is required");
      return;
    }

    if (newField.type === "related" && !newField.relatedModel) {
      toast.error("Please select a related model for this field");
      return;
    }

    if ((newField.type === "select" || newField.type === "multiselect") && newField.options.length === 0) {
      toast.error("Please add at least one option for this field");
      return;
    }

    setIsSubmitting(true);
    try {
      const validationRules: Record<string, any> = {};
      if (newField.validationMin) validationRules.min = Number(newField.validationMin);
      if (newField.validationMax) validationRules.max = Number(newField.validationMax);
      if (newField.validationRegex) {
        validationRules.regex = newField.validationRegex;
        if (newField.validationMessage) validationRules.message = newField.validationMessage;
      }

      await addField(newField.label, newField.type, {
        placeholder: newField.placeholder || null,
        help_text: newField.helpText || null,
        is_required: newField.isRequired,
        options: newField.type === "select" || newField.type === "multiselect" 
          ? newField.options 
          : [],
        related_model: newField.type === "related" ? newField.relatedModel : null,
        related_display_field: newField.type === "related" ? (newField.relatedDisplayField || null) : null,
        field_group: newField.fieldGroup || null,
        default_value: newField.defaultValue || null,
        validation_rules: Object.keys(validationRules).length > 0 ? validationRules as any : {} as any,
        computation_formula: newField.type === "computed" ? (newField.computationFormula || null) : null,
        computation_dependencies: newField.type === "computed" && newField.computationDependencies.length > 0 
          ? newField.computationDependencies : null,
      });
      setShowAddDialog(false);
      resetNewField();
    } catch (error: any) {
      toast.error(normalizeError(error).message || "Failed to add field");
    } finally {
      setIsSubmitting(false);
    }
  };

  const resetNewField = () => {
    setNewField({
      label: "",
      type: "text",
      placeholder: "",
      helpText: "",
      isRequired: false,
      options: [],
      relatedModel: "",
      relatedDisplayField: "",
      fieldGroup: "",
      defaultValue: "",
      validationMin: "",
      validationMax: "",
      validationRegex: "",
      validationMessage: "",
      computationFormula: "",
      computationDependencies: [],
    });
    setNewOption({ value: "", label: "" });
    setShowAdvanced(false);
  };

  const handleEditField = async () => {
    if (!selectedField) return;

    setIsSubmitting(true);
    try {
      const updates: Partial<EntityFieldConfig> = {
        field_label: selectedField.field_label,
        placeholder: selectedField.placeholder,
        help_text: selectedField.help_text,
        options: selectedField.options,
        document_section: selectedField.document_section,
        related_model: selectedField.related_model,
        related_display_field: selectedField.related_display_field,
        field_group: selectedField.field_group,
        default_value: selectedField.default_value,
        validation_rules: selectedField.validation_rules,
        conditional_visibility: selectedField.conditional_visibility,
        computation_formula: selectedField.computation_formula,
        computation_dependencies: selectedField.computation_dependencies,
      };
      await updateField(selectedField.id, updates);
      setShowEditDialog(false);
      setSelectedField(null);
      setShowEditAdvanced(false);
    } catch (error: any) {
      toast.error(normalizeError(error).message || "Failed to update field");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDeleteField = async () => {
    if (!selectedField) return;

    setIsSubmitting(true);
    try {
      await deleteField(selectedField.id);
      setShowDeleteDialog(false);
      setSelectedField(null);
    } catch (error: any) {
      toast.error(normalizeError(error).message || "Failed to delete field");
    } finally {
      setIsSubmitting(false);
    }
  };

  const addOption = () => {
    if (!newOption.value.trim() || !newOption.label.trim()) {
      toast.error("Both value and label are required");
      return;
    }
    setNewField({
      ...newField,
      options: [...newField.options, { ...newOption }],
    });
    setNewOption({ value: "", label: "" });
  };

  const removeOption = (index: number) => {
    setNewField({
      ...newField,
      options: newField.options.filter((_, i) => i !== index),
    });
  };

  const addEditOption = () => {
    if (!editNewOption.value.trim() || !editNewOption.label.trim()) {
      toast.error("Both value and label are required");
      return;
    }
    if (!selectedField) return;
    setSelectedField({
      ...selectedField,
      options: [...(selectedField.options || []), { ...editNewOption }],
    });
    setEditNewOption({ value: "", label: "" });
  };

  const removeEditOption = (index: number) => {
    if (!selectedField) return;
    setSelectedField({
      ...selectedField,
      options: (selectedField.options || []).filter((_, i) => i !== index),
    });
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3 sm:pb-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base sm:text-lg">
              <Settings2 className="h-4 w-4 sm:h-5 sm:w-5" />
              {title}
            </CardTitle>
            <CardDescription className="text-xs sm:text-sm">{description}</CardDescription>
          </div>
          <Button onClick={() => setShowAddDialog(true)} size="sm" className="w-full sm:w-auto">
            <Plus className="mr-2 h-4 w-4" />
            Add Custom Field
          </Button>
        </div>
      </CardHeader>
      <CardContent className="px-3 sm:px-6">
        {/* Mobile Card Layout */}
        <div className="md:hidden space-y-3">
          {fieldConfigs.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Settings2 className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p>No custom fields configured</p>
              <p className="text-sm">Tap "Add Custom Field" to create one</p>
            </div>
          ) : (
            fieldConfigs.map((field) => (
              <Card key={field.id} className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm">{field.field_label}</span>
                      <Badge variant="outline" className="text-xs">
                        {FIELD_TYPE_LABELS[field.field_type] || field.field_type}
                      </Badge>
                    </div>
                    {field.help_text && (
                      <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                        {field.help_text}
                      </p>
                    )}
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0">
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => {
                        setSelectedField(field);
                        setShowEditDialog(true);
                      }}>
                        <Pencil className="mr-2 h-4 w-4" />
                        Edit
                      </DropdownMenuItem>
                      <DropdownMenuItem 
                        onClick={() => {
                          setSelectedField(field);
                          setShowDeleteDialog(true);
                        }}
                        className="text-destructive"
                      >
                        <Trash2 className="mr-2 h-4 w-4" />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-muted-foreground">Required</span>
                    <Switch
                      checked={field.is_required}
                      onCheckedChange={() => handleToggleRequired(field)}
                    />
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-muted-foreground">Visible</span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => handleToggleVisibility(field)}
                    >
                      {field.is_visible ? (
                        <Eye className="h-4 w-4 text-green-600" />
                      ) : (
                        <EyeOff className="h-4 w-4 text-muted-foreground" />
                      )}
                    </Button>
                  </div>
                </div>
              </Card>
            ))
          )}
        </div>

        {/* Desktop Table Layout */}
        <div className="hidden md:block rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8"></TableHead>
                <TableHead>Field Label</TableHead>
                <TableHead>Type</TableHead>
                <TableHead className="text-center">Required</TableHead>
                <TableHead className="text-center">Visible</TableHead>
                <TableHead className="w-24">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {fieldConfigs.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                    No custom fields configured. Click "Add Custom Field" to create one.
                  </TableCell>
                </TableRow>
              ) : (
                fieldConfigs.map((field) => (
                  <TableRow key={field.id}>
                    <TableCell>
                      <span className="text-muted-foreground/40 text-xs">⋮⋮</span>
                    </TableCell>
                    <TableCell>
                      <div>
                        <span className="font-medium">{field.field_label}</span>
                        {field.field_group && (
                          <Badge variant="secondary" className="ml-2 text-xs">{field.field_group}</Badge>
                        )}
                        {field.help_text && (
                          <p className="text-xs text-muted-foreground mt-1">
                            {field.help_text}
                          </p>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">
                        {FIELD_TYPE_LABELS[field.field_type] || field.field_type}
                      </Badge>
                      {field.field_type === "related" && field.related_model && (
                        <span className="text-xs text-muted-foreground ml-1">→ {field.related_model}</span>
                      )}
                    </TableCell>
                    <TableCell className="text-center">
                      <Switch
                        checked={field.is_required}
                        onCheckedChange={() => handleToggleRequired(field)}
                      />
                    </TableCell>
                    <TableCell className="text-center">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleToggleVisibility(field)}
                      >
                        {field.is_visible ? (
                          <Eye className="h-4 w-4 text-green-600" />
                        ) : (
                          <EyeOff className="h-4 w-4 text-muted-foreground" />
                        )}
                      </Button>
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => {
                            setSelectedField(field);
                            setShowEditDialog(true);
                          }}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => {
                            setSelectedField(field);
                            setShowDeleteDialog(true);
                          }}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>

      {/* ==================== ADD CUSTOM FIELD DIALOG ==================== */}
      <Dialog open={showAddDialog} onOpenChange={setShowAddDialog}>
        <DialogContent className="max-w-[95vw] sm:max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Add Custom Field</DialogTitle>
            <DialogDescription>
              Create a new custom field for {ENTITY_TYPE_LABELS[entityType]}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {/* Label */}
            <div className="space-y-2">
              <Label htmlFor="field-label">Field Label *</Label>
              <Input
                id="field-label"
                value={newField.label}
                onChange={(e) => setNewField({ ...newField, label: e.target.value })}
                placeholder="e.g., Customer Reference"
              />
            </div>

            {/* Type */}
            <div className="space-y-2">
              <Label htmlFor="field-type">Field Type</Label>
              <Select
                value={newField.type}
                onValueChange={(value) => setNewField({ ...newField, type: value as FieldType, relatedModel: "", relatedDisplayField: "" })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(FIELD_TYPE_LABELS)
                    .filter(([value]) => value !== "computed")
                    .map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>

            {/* Related Model selector — shown when type === "related" */}
            {newField.type === "related" && (
              <div className="space-y-3 rounded-md border p-3 bg-muted/30">
                <div className="space-y-2">
                  <Label>Related Entity *</Label>
                  <Select
                    value={newField.relatedModel}
                    onValueChange={(v) => setNewField({ ...newField, relatedModel: v, relatedDisplayField: "" })}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select the entity to look up..." />
                    </SelectTrigger>
                    <SelectContent>
                      {RELATED_MODEL_OPTIONS.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {newField.relatedModel && RELATED_DISPLAY_FIELDS[newField.relatedModel] && (
                  <div className="space-y-2">
                    <Label>Display Field</Label>
                    <Select
                      value={newField.relatedDisplayField}
                      onValueChange={(v) => setNewField({ ...newField, relatedDisplayField: v })}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Default (name)" />
                      </SelectTrigger>
                      <SelectContent>
                        {RELATED_DISPLAY_FIELDS[newField.relatedModel].map((df) => (
                          <SelectItem key={df.value} value={df.value}>{df.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">Which field to show in the lookup results</p>
                  </div>
                )}
              </div>
            )}

            {/* Options editor — shown for select/multiselect */}
            {(newField.type === "select" || newField.type === "multiselect") && (
              <div className="space-y-2">
                <Label>Options *</Label>
                <div className="flex flex-col sm:flex-row gap-2">
                  <Input
                    placeholder="Value"
                    value={newOption.value}
                    onChange={(e) => setNewOption({ ...newOption, value: e.target.value })}
                    className="flex-1"
                  />
                  <Input
                    placeholder="Label"
                    value={newOption.label}
                    onChange={(e) => setNewOption({ ...newOption, label: e.target.value })}
                    className="flex-1"
                  />
                  <Button type="button" variant="outline" onClick={addOption} className="shrink-0">
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>
                {newField.options.length > 0 && (
                  <div className="flex flex-wrap gap-2 mt-2">
                    {newField.options.map((opt, index) => (
                      <Badge key={index} variant="secondary" className="flex items-center gap-1">
                        {opt.label}
                        <X
                          className="h-3 w-3 cursor-pointer"
                          onClick={() => removeOption(index)}
                        />
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Placeholder */}
            <div className="space-y-2">
              <Label htmlFor="field-placeholder">Placeholder</Label>
              <Input
                id="field-placeholder"
                value={newField.placeholder}
                onChange={(e) => setNewField({ ...newField, placeholder: e.target.value })}
                placeholder="Enter placeholder text..."
              />
            </div>

            {/* Help Text */}
            <div className="space-y-2">
              <Label htmlFor="field-help">Help Text</Label>
              <Textarea
                id="field-help"
                value={newField.helpText}
                onChange={(e) => setNewField({ ...newField, helpText: e.target.value })}
                placeholder="Enter help text shown below the field..."
                rows={2}
              />
            </div>

            {/* Toggles */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="flex items-center gap-2">
                <Switch
                  id="required"
                  checked={newField.isRequired}
                  onCheckedChange={(checked) => setNewField({ ...newField, isRequired: checked })}
                />
                <Label htmlFor="required" className="text-sm">Required</Label>
              </div>
            </div>

            {/* Advanced Settings (collapsible) */}
            <Collapsible open={showAdvanced} onOpenChange={setShowAdvanced}>
              <CollapsibleTrigger asChild>
                <Button variant="ghost" size="sm" className="w-full justify-between text-muted-foreground">
                  Advanced Settings
                  {showAdvanced ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="space-y-4 pt-2">
                {/* Field Group */}
                <div className="space-y-2">
                  <Label htmlFor="field-group">Field Group</Label>
                  <Input
                    id="field-group"
                    value={newField.fieldGroup}
                    onChange={(e) => setNewField({ ...newField, fieldGroup: e.target.value })}
                    placeholder="e.g., Dimensions, Shipping Info"
                  />
                  <p className="text-xs text-muted-foreground">Fields with the same group name are displayed together</p>
                </div>

                {/* Default Value */}
                {["text", "number", "select", "date"].includes(newField.type) && (
                  <div className="space-y-2">
                    <Label htmlFor="default-value">Default Value</Label>
                    <Input
                      id="default-value"
                      value={newField.defaultValue}
                      onChange={(e) => setNewField({ ...newField, defaultValue: e.target.value })}
                      placeholder="Value to pre-fill for new records"
                    />
                  </div>
                )}

                {/* Validation Rules */}
                {newField.type === "number" && (
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <Label>Min Value</Label>
                      <Input
                        type="number"
                        value={newField.validationMin}
                        onChange={(e) => setNewField({ ...newField, validationMin: e.target.value })}
                        placeholder="No minimum"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Max Value</Label>
                      <Input
                        type="number"
                        value={newField.validationMax}
                        onChange={(e) => setNewField({ ...newField, validationMax: e.target.value })}
                        placeholder="No maximum"
                      />
                    </div>
                  </div>
                )}
                {newField.type === "text" && (
                  <div className="space-y-3">
                    <div className="space-y-2">
                      <Label>Validation Pattern (Regex)</Label>
                      <Input
                        value={newField.validationRegex}
                        onChange={(e) => setNewField({ ...newField, validationRegex: e.target.value })}
                        placeholder="e.g., ^[A-Z]{2}-\\d{4}$"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Validation Error Message</Label>
                      <Input
                        value={newField.validationMessage}
                        onChange={(e) => setNewField({ ...newField, validationMessage: e.target.value })}
                        placeholder="e.g., Must match format XX-0000"
                      />
                    </div>
                  </div>
                )}
              </CollapsibleContent>
            </Collapsible>
          </div>
          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button variant="outline" onClick={() => { setShowAddDialog(false); resetNewField(); }} className="w-full sm:w-auto">
              Cancel
            </Button>
            <Button onClick={handleAddField} disabled={isSubmitting} className="w-full sm:w-auto">
              {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Add Field
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ==================== EDIT FIELD DIALOG ==================== */}
      <Dialog open={showEditDialog} onOpenChange={setShowEditDialog}>
        <DialogContent className="max-w-[95vw] sm:max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Field</DialogTitle>
            <DialogDescription>
              Update the field settings
            </DialogDescription>
          </DialogHeader>
          {selectedField && (
            <div className="space-y-4">
              {/* Label */}
              <div className="space-y-2">
                <Label htmlFor="edit-field-label">Field Label</Label>
                <Input
                  id="edit-field-label"
                  value={selectedField.field_label}
                  onChange={(e) => setSelectedField({ ...selectedField, field_label: e.target.value })}
                />
              </div>

              {/* Type (read-only) */}
              <div className="space-y-2">
                <Label>Field Type</Label>
                <Badge variant="outline">
                  {FIELD_TYPE_LABELS[selectedField.field_type] || selectedField.field_type}
                </Badge>
                <p className="text-xs text-muted-foreground">Field type cannot be changed after creation</p>
              </div>

              {/* Related Model — for related type */}
              {selectedField.field_type === "related" && (
                <div className="space-y-3 rounded-md border p-3 bg-muted/30">
                  <div className="space-y-2">
                    <Label>Related Entity</Label>
                    <Select
                      value={selectedField.related_model || ""}
                      onValueChange={(v) => setSelectedField({ ...selectedField, related_model: v, related_display_field: "" })}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select the entity to look up..." />
                      </SelectTrigger>
                      <SelectContent>
                        {RELATED_MODEL_OPTIONS.map((opt) => (
                          <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  {selectedField.related_model && RELATED_DISPLAY_FIELDS[selectedField.related_model] && (
                    <div className="space-y-2">
                      <Label>Display Field</Label>
                      <Select
                        value={selectedField.related_display_field || ""}
                        onValueChange={(v) => setSelectedField({ ...selectedField, related_display_field: v })}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Default (name)" />
                        </SelectTrigger>
                        <SelectContent>
                          {RELATED_DISPLAY_FIELDS[selectedField.related_model].map((df) => (
                            <SelectItem key={df.value} value={df.value}>{df.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                </div>
              )}

              {/* Options editor — for select/multiselect */}
              {(selectedField.field_type === "select" || selectedField.field_type === "multiselect") && (
                <div className="space-y-2">
                  <Label>Options</Label>
                  <div className="flex flex-col sm:flex-row gap-2">
                    <Input
                      placeholder="Value"
                      value={editNewOption.value}
                      onChange={(e) => setEditNewOption({ ...editNewOption, value: e.target.value })}
                      className="flex-1"
                    />
                    <Input
                      placeholder="Label"
                      value={editNewOption.label}
                      onChange={(e) => setEditNewOption({ ...editNewOption, label: e.target.value })}
                      className="flex-1"
                    />
                    <Button type="button" variant="outline" onClick={addEditOption} className="shrink-0">
                      <Plus className="h-4 w-4" />
                    </Button>
                  </div>
                  {(selectedField.options || []).length > 0 && (
                    <div className="flex flex-wrap gap-2 mt-2">
                      {(selectedField.options || []).map((opt, index) => (
                        <Badge key={index} variant="secondary" className="flex items-center gap-1">
                          {opt.label} <span className="text-muted-foreground">({opt.value})</span>
                          <X
                            className="h-3 w-3 cursor-pointer"
                            onClick={() => removeEditOption(index)}
                          />
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Placeholder */}
              <div className="space-y-2">
                <Label htmlFor="edit-field-placeholder">Placeholder</Label>
                <Input
                  id="edit-field-placeholder"
                  value={selectedField.placeholder || ""}
                  onChange={(e) => setSelectedField({ ...selectedField, placeholder: e.target.value })}
                />
              </div>

              {/* Help Text */}
              <div className="space-y-2">
                <Label htmlFor="edit-field-help">Help Text</Label>
                <Textarea
                  id="edit-field-help"
                  value={selectedField.help_text || ""}
                  onChange={(e) => setSelectedField({ ...selectedField, help_text: e.target.value })}
                  rows={2}
                />
              </div>

              {/* Document Placement - only for document entity types */}
              {['invoice', 'estimate', 'sales_order', 'purchase_order', 'bill', 'expense'].includes(entityType) && (
                <div className="space-y-2">
                  <Label htmlFor="edit-document-section">Document Placement</Label>
                  <Select
                    value={selectedField.document_section || "additional"}
                    onValueChange={(v) => setSelectedField({ ...selectedField, document_section: v })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="header">Header (near invoice number)</SelectItem>
                      <SelectItem value="details">Customer Details</SelectItem>
                      <SelectItem value="after_items">After Items Table</SelectItem>
                      <SelectItem value="notes">Notes Section</SelectItem>
                      <SelectItem value="footer">Footer</SelectItem>
                      <SelectItem value="additional">Additional Information</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">Where this field appears on the printed document</p>
                </div>
              )}

              {/* Advanced Settings (collapsible) */}
              <Collapsible open={showEditAdvanced} onOpenChange={setShowEditAdvanced}>
                <CollapsibleTrigger asChild>
                  <Button variant="ghost" size="sm" className="w-full justify-between text-muted-foreground">
                    Advanced Settings
                    {showEditAdvanced ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent className="space-y-4 pt-2">
                  {/* Field Group */}
                  <div className="space-y-2">
                    <Label>Field Group</Label>
                    <Input
                      value={selectedField.field_group || ""}
                      onChange={(e) => setSelectedField({ ...selectedField, field_group: e.target.value || null })}
                      placeholder="e.g., Dimensions, Shipping Info"
                    />
                  </div>

                  {/* Default Value */}
                  {["text", "number", "select", "date"].includes(selectedField.field_type) && (
                    <div className="space-y-2">
                      <Label>Default Value</Label>
                      <Input
                        value={selectedField.default_value || ""}
                        onChange={(e) => setSelectedField({ ...selectedField, default_value: e.target.value || null })}
                        placeholder="Value to pre-fill for new records"
                      />
                    </div>
                  )}

                  {/* Validation Rules */}
                  {selectedField.field_type === "number" && (
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-2">
                        <Label>Min Value</Label>
                        <Input
                          type="number"
                          value={selectedField.validation_rules?.min ?? ""}
                          onChange={(e) => setSelectedField({
                            ...selectedField,
                            validation_rules: {
                              ...selectedField.validation_rules,
                              min: e.target.value ? Number(e.target.value) : undefined,
                            },
                          })}
                          placeholder="No minimum"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>Max Value</Label>
                        <Input
                          type="number"
                          value={selectedField.validation_rules?.max ?? ""}
                          onChange={(e) => setSelectedField({
                            ...selectedField,
                            validation_rules: {
                              ...selectedField.validation_rules,
                              max: e.target.value ? Number(e.target.value) : undefined,
                            },
                          })}
                          placeholder="No maximum"
                        />
                      </div>
                    </div>
                  )}
                  {selectedField.field_type === "text" && (
                    <div className="space-y-3">
                      <div className="space-y-2">
                        <Label>Validation Pattern (Regex)</Label>
                        <Input
                          value={selectedField.validation_rules?.regex || ""}
                          onChange={(e) => setSelectedField({
                            ...selectedField,
                            validation_rules: {
                              ...selectedField.validation_rules,
                              regex: e.target.value || undefined,
                            },
                          })}
                          placeholder="e.g., ^[A-Z]{2}-\\d{4}$"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>Validation Error Message</Label>
                        <Input
                          value={selectedField.validation_rules?.message || ""}
                          onChange={(e) => setSelectedField({
                            ...selectedField,
                            validation_rules: {
                              ...selectedField.validation_rules,
                              message: e.target.value || undefined,
                            },
                          })}
                          placeholder="e.g., Must match format XX-0000"
                        />
                      </div>
                    </div>
                  )}

                  {/* Conditional Visibility */}
                  <div className="space-y-3 rounded-md border p-3">
                    <div className="flex items-center justify-between">
                      <Label className="text-sm font-medium">Conditional Visibility</Label>
                      <Switch
                        checked={!!selectedField.conditional_visibility}
                        onCheckedChange={(checked) => {
                          if (checked) {
                            setSelectedField({
                              ...selectedField,
                              conditional_visibility: { field: "", operator: "=", value: "" },
                            });
                          } else {
                            setSelectedField({ ...selectedField, conditional_visibility: null });
                          }
                        }}
                      />
                    </div>
                    <p className="text-xs text-muted-foreground">Show this field only when another field meets a condition</p>
                    {selectedField.conditional_visibility && (
                      <div className="space-y-3 pt-1">
                        <div className="space-y-2">
                          <Label className="text-xs">Controlling Field</Label>
                          <Select
                            value={selectedField.conditional_visibility.field}
                            onValueChange={(v) => setSelectedField({
                              ...selectedField,
                              conditional_visibility: { ...selectedField.conditional_visibility!, field: v },
                            })}
                          >
                            <SelectTrigger>
                              <SelectValue placeholder="Select a field..." />
                            </SelectTrigger>
                            <SelectContent>
                              {fieldConfigs
                                .filter(f => f.id !== selectedField.id)
                                .map((f) => (
                                  <SelectItem key={f.field_key} value={f.field_key}>
                                    {f.field_label}
                                  </SelectItem>
                                ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-2">
                          <Label className="text-xs">Operator</Label>
                          <Select
                            value={selectedField.conditional_visibility.operator}
                            onValueChange={(v) => setSelectedField({
                              ...selectedField,
                              conditional_visibility: { ...selectedField.conditional_visibility!, operator: v as any },
                            })}
                          >
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {VISIBILITY_OPERATORS.map((op) => (
                                <SelectItem key={op.value} value={op.value}>{op.label}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        {!["is_empty", "is_not_empty"].includes(selectedField.conditional_visibility.operator) && (
                          <div className="space-y-2">
                            <Label className="text-xs">Value</Label>
                            <Input
                              value={String(selectedField.conditional_visibility.value ?? "")}
                              onChange={(e) => setSelectedField({
                                ...selectedField,
                                conditional_visibility: { ...selectedField.conditional_visibility!, value: e.target.value },
                              })}
                              placeholder="Value to compare against"
                            />
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            </div>
          )}
          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button variant="outline" onClick={() => setShowEditDialog(false)} className="w-full sm:w-auto">
              Cancel
            </Button>
            <Button onClick={handleEditField} disabled={isSubmitting} className="w-full sm:w-auto">
              {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent className="max-w-[95vw] sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Field</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{selectedField?.field_label}"? 
              This action cannot be undone and any data stored in this field will be lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col sm:flex-row gap-2">
            <AlertDialogCancel className="w-full sm:w-auto">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteField}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90 w-full sm:w-auto"
            >
              {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
