import { useState } from "react";
import { useEmployeeFields, EmployeeFieldConfig } from "@/hooks/useEmployeeFields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import {
  Plus,
  Pencil,
  Trash2,
  Eye,
  EyeOff,
  GripVertical,
  Loader2,
  AlertCircle,
  Settings2,
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

const FIELD_TYPE_LABELS: Record<string, string> = {
  text: "Text",
  number: "Number",
  date: "Date",
  select: "Dropdown",
  email: "Email",
  phone: "Phone",
  textarea: "Long Text",
};

const CATEGORY_LABELS: Record<string, string> = {
  personal: "Personal Information",
  employment: "Employment Details",
  statutory: "Statutory Deductions",
  banking: "Bank Details",
  custom: "Custom Fields",
};

export function EmployeeFieldSettings() {
  const {
    fieldConfigs,
    isLoading,
    updateFieldConfig,
    addCustomField,
    deleteFieldConfig,
    initializeDefaultFields,
  } = useEmployeeFields();

  const [activeTab, setActiveTab] = useState<string>("personal");
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [selectedField, setSelectedField] = useState<EmployeeFieldConfig | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [newField, setNewField] = useState({
    label: "",
    type: "text" as EmployeeFieldConfig["field_type"],
    category: "custom" as EmployeeFieldConfig["field_category"],
  });

  const handleToggleVisibility = async (field: EmployeeFieldConfig) => {
    try {
      await updateFieldConfig(field.id, { is_visible: !field.is_visible });
    } catch (error: any) {
      toast.error(normalizeError(error).message || "Failed to update field");
    }
  };

  const handleToggleRequired = async (field: EmployeeFieldConfig) => {
    if (field.is_system && field.is_required) {
      toast.error("System required fields cannot be made optional");
      return;
    }
    try {
      await updateFieldConfig(field.id, { is_required: !field.is_required });
    } catch (error: any) {
      toast.error(normalizeError(error).message || "Failed to update field");
    }
  };

  const handleAddField = async () => {
    if (!newField.label.trim()) {
      toast.error("Field label is required");
      return;
    }

    setIsSubmitting(true);
    try {
      await addCustomField(newField.label, newField.type, newField.category);
      setShowAddDialog(false);
      setNewField({ label: "", type: "text", category: "custom" });
    } catch (error: any) {
      toast.error(normalizeError(error).message || "Failed to add field");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleEditField = async () => {
    if (!selectedField) return;

    setIsSubmitting(true);
    try {
      await updateFieldConfig(selectedField.id, {
        field_label: selectedField.field_label,
        placeholder: selectedField.placeholder,
        help_text: selectedField.help_text,
      });
      setShowEditDialog(false);
      setSelectedField(null);
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
      await deleteFieldConfig(selectedField.id);
      setShowDeleteDialog(false);
      setSelectedField(null);
    } catch (error: any) {
      toast.error(normalizeError(error).message || "Failed to delete field");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleInitialize = async () => {
    setIsSubmitting(true);
    try {
      await initializeDefaultFields();
    } catch (error: any) {
      toast.error(normalizeError(error).message || "Failed to initialize fields");
    } finally {
      setIsSubmitting(false);
    }
  };

  const getFieldsForCategory = (category: string) => {
    return fieldConfigs
      .filter((f) => f.field_category === category)
      .sort((a, b) => a.display_order - b.display_order);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const hasDefaultConfigsOnly = fieldConfigs.every((f) => f.id.startsWith("default-"));

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Settings2 className="h-5 w-5" />
              Employee Field Configuration
            </CardTitle>
            <CardDescription>
              Customize which fields appear in the employee form and add custom fields
            </CardDescription>
          </div>
          <div className="flex gap-2">
            {hasDefaultConfigsOnly && (
              <Button variant="outline" onClick={handleInitialize} disabled={isSubmitting}>
                {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Initialize Defaults
              </Button>
            )}
            <Button onClick={() => setShowAddDialog(true)}>
              <Plus className="mr-2 h-4 w-4" />
              Add Custom Field
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="grid w-full grid-cols-5">
            <TabsTrigger value="personal">Personal</TabsTrigger>
            <TabsTrigger value="employment">Employment</TabsTrigger>
            <TabsTrigger value="statutory">Statutory</TabsTrigger>
            <TabsTrigger value="banking">Banking</TabsTrigger>
            <TabsTrigger value="custom">Custom</TabsTrigger>
          </TabsList>

          {Object.keys(CATEGORY_LABELS).map((category) => (
            <TabsContent key={category} value={category} className="mt-4">
              <div className="rounded-md border">
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
                    {getFieldsForCategory(category).length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                          No fields in this category.{" "}
                          {category === "custom" && "Click 'Add Custom Field' to create one."}
                        </TableCell>
                      </TableRow>
                    ) : (
                      getFieldsForCategory(category).map((field) => (
                        <TableRow key={field.id}>
                          <TableCell>
                            <GripVertical className="h-4 w-4 text-muted-foreground cursor-move" />
                          </TableCell>
                          <TableCell>
                            <div>
                              <span className="font-medium">{field.field_label}</span>
                              {field.is_system && (
                                <Badge variant="secondary" className="ml-2 text-xs">
                                  System
                                </Badge>
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
                          </TableCell>
                          <TableCell className="text-center">
                            <Switch
                              checked={field.is_required}
                              onCheckedChange={() => handleToggleRequired(field)}
                              disabled={field.is_system && field.is_required}
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
                              {!field.is_system && (
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
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </TabsContent>
          ))}
        </Tabs>
      </CardContent>

      {/* Add Custom Field Dialog */}
      <Dialog open={showAddDialog} onOpenChange={setShowAddDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Custom Field</DialogTitle>
            <DialogDescription>
              Create a new custom field for employee records
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="field-label">Field Label</Label>
              <Input
                id="field-label"
                value={newField.label}
                onChange={(e) => setNewField({ ...newField, label: e.target.value })}
                placeholder="e.g., Emergency Contact"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="field-type">Field Type</Label>
              <Select
                value={newField.type}
                onValueChange={(value) =>
                  setNewField({ ...newField, type: value as EmployeeFieldConfig["field_type"] })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(FIELD_TYPE_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="field-category">Category</Label>
              <Select
                value={newField.category}
                onValueChange={(value) =>
                  setNewField({ ...newField, category: value as EmployeeFieldConfig["field_category"] })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(CATEGORY_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAddDialog(false)}>
              Cancel
            </Button>
            <Button onClick={handleAddField} disabled={isSubmitting}>
              {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Add Field
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Field Dialog */}
      <Dialog open={showEditDialog} onOpenChange={setShowEditDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Field</DialogTitle>
            <DialogDescription>Update field label and help text</DialogDescription>
          </DialogHeader>
          {selectedField && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="edit-label">Field Label</Label>
                <Input
                  id="edit-label"
                  value={selectedField.field_label}
                  onChange={(e) =>
                    setSelectedField({ ...selectedField, field_label: e.target.value })
                  }
                  disabled={selectedField.is_system}
                />
                {selectedField.is_system && (
                  <p className="text-xs text-muted-foreground flex items-center gap-1">
                    <AlertCircle className="h-3 w-3" />
                    System field labels cannot be changed
                  </p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-placeholder">Placeholder</Label>
                <Input
                  id="edit-placeholder"
                  value={selectedField.placeholder || ""}
                  onChange={(e) =>
                    setSelectedField({ ...selectedField, placeholder: e.target.value || null })
                  }
                  placeholder="Enter placeholder text..."
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-help">Help Text</Label>
                <Input
                  id="edit-help"
                  value={selectedField.help_text || ""}
                  onChange={(e) =>
                    setSelectedField({ ...selectedField, help_text: e.target.value || null })
                  }
                  placeholder="Enter help text..."
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowEditDialog(false)}>
              Cancel
            </Button>
            <Button onClick={handleEditField} disabled={isSubmitting}>
              {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Custom Field</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete the field "{selectedField?.field_label}"? This will
              also remove all data stored in this field for all employees. This action cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteField}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
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
