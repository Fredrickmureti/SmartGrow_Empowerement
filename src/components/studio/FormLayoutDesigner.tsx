import { useState, useCallback } from "react";
import { useFormLayouts, FormLayout, FormTab, FormGroup, LayoutConfig, FieldOverride } from "@/hooks/useFormLayouts";
import { useAllEntityFields, ENTITY_TYPE_LABELS, EntityType } from "@/hooks/useEntityFields";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import {
  Plus,
  MoreHorizontal,
  Pencil,
  Trash2,
  Layout,
  FolderPlus,
  PanelTop,
  Users,
  Package,
  FileSpreadsheet,
  FileText,
  ShoppingCart,
  Briefcase,
  Receipt,
  DollarSign,
  ChevronDown,
  ChevronRight,
  GripVertical,
  Columns2,
  Columns3,
  Columns4,
  Save,
  X,
  RefreshCw,
} from "lucide-react";
import { normalizeError } from "@/services/resilience";

const ENTITY_ICONS: Record<EntityType, React.ReactNode> = {
  contact: <Users className="h-4 w-4" />,
  product: <Package className="h-4 w-4" />,
  invoice: <FileSpreadsheet className="h-4 w-4" />,
  estimate: <FileText className="h-4 w-4" />,
  sales_order: <ShoppingCart className="h-4 w-4" />,
  purchase_order: <ShoppingCart className="h-4 w-4" />,
  project: <Briefcase className="h-4 w-4" />,
  crm_lead: <Users className="h-4 w-4" />,
  expense: <DollarSign className="h-4 w-4" />,
  bill: <Receipt className="h-4 w-4" />,
  employee: <Users className="h-4 w-4" />,
  credit_note: <Receipt className="h-4 w-4" />,
  payment: <DollarSign className="h-4 w-4" />,
  delivery_note: <Package className="h-4 w-4" />,
  sales_return: <ShoppingCart className="h-4 w-4" />,
  proforma_invoice: <FileText className="h-4 w-4" />,
  recurring_invoice: <RefreshCw className="h-4 w-4" />,
  stock_adjustment: <Package className="h-4 w-4" />,
};

const COLUMN_OPTIONS: { value: 1 | 2 | 3 | 4; label: string; icon: React.ReactNode }[] = [
  { value: 1, label: "1 Column", icon: <div className="w-4 h-4 border rounded" /> },
  { value: 2, label: "2 Columns", icon: <Columns2 className="h-4 w-4" /> },
  { value: 3, label: "3 Columns", icon: <Columns3 className="h-4 w-4" /> },
  { value: 4, label: "4 Columns", icon: <Columns4 className="h-4 w-4" /> },
];

const WIDTH_OPTIONS: { value: FieldOverride["width"]; label: string }[] = [
  { value: "full", label: "Full Width" },
  { value: "three-quarters", label: "3/4 Width" },
  { value: "two-thirds", label: "2/3 Width" },
  { value: "half", label: "1/2 Width" },
  { value: "third", label: "1/3 Width" },
  { value: "quarter", label: "1/4 Width" },
];

interface FormLayoutDesignerProps {
  entityType?: EntityType;
}

export function FormLayoutDesigner({ entityType: initialEntityType }: FormLayoutDesignerProps) {
  const [selectedEntityType, setSelectedEntityType] = useState<EntityType>(initialEntityType || "contact");
  const { layouts, isLoading, createLayout, updateLayout, deleteLayout } = useFormLayouts(selectedEntityType);
  const { getFieldsForEntityType } = useAllEntityFields();
  
  const [showDialog, setShowDialog] = useState(false);
  const [editingLayout, setEditingLayout] = useState<FormLayout | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [expandedLayout, setExpandedLayout] = useState<string | null>(null);
  const [editingStructure, setEditingStructure] = useState<string | null>(null);
  const [structureConfig, setStructureConfig] = useState<LayoutConfig | null>(null);
  const [isSavingStructure, setIsSavingStructure] = useState(false);
  
  const [formData, setFormData] = useState({
    layout_name: "",
    is_default: false,
  });

  const availableFields = getFieldsForEntityType(selectedEntityType);

  const resetForm = () => {
    setFormData({ layout_name: "", is_default: false });
    setEditingLayout(null);
  };

  const handleOpenDialog = (layout?: FormLayout) => {
    if (layout) {
      setEditingLayout(layout);
      setFormData({ layout_name: layout.layout_name, is_default: layout.is_default });
    } else {
      resetForm();
    }
    setShowDialog(true);
  };

  const handleSubmit = async () => {
    if (!formData.layout_name.trim()) {
      toast.error("Layout name is required");
      return;
    }
    setIsSubmitting(true);
    try {
      if (editingLayout) {
        await updateLayout(editingLayout.id, {
          layout_name: formData.layout_name,
          is_default: formData.is_default,
        });
      } else {
        const ts = Date.now();
        const defaultConfig: LayoutConfig = {
          tabs: [{ id: `tab_${ts}`, label: "General", groups: [`group_${ts}`] }],
          groups: [{ id: `group_${ts}`, label: "Basic Information", columns: 2, fields: [] }],
          field_overrides: {},
        };
        await createLayout(formData.layout_name, defaultConfig, formData.is_default);
      }
      setShowDialog(false);
      resetForm();
    } catch (error: any) {
      toast.error(normalizeError(error).message || "Failed to save layout");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async (layout: FormLayout) => {
    if (!confirm(`Delete "${layout.layout_name}"?`)) return;
    try {
      await deleteLayout(layout.id);
      if (editingStructure === layout.id) {
        setEditingStructure(null);
        setStructureConfig(null);
      }
    } catch (error: any) {
      toast.error(normalizeError(error).message || "Failed to delete layout");
    }
  };

  // === Structure editing helpers ===
  const startEditingStructure = (layout: FormLayout) => {
    setEditingStructure(layout.id);
    setStructureConfig(JSON.parse(JSON.stringify(layout.layout_config)));
    setExpandedLayout(layout.id);
  };

  const cancelEditingStructure = () => {
    setEditingStructure(null);
    setStructureConfig(null);
  };

  const saveStructure = async () => {
    if (!editingStructure || !structureConfig) return;
    setIsSavingStructure(true);
    try {
      await updateLayout(editingStructure, { layout_config: structureConfig } as any);
      setEditingStructure(null);
      setStructureConfig(null);
      toast.success("Layout structure saved");
    } catch (error: any) {
      toast.error(normalizeError(error).message || "Failed to save structure");
    } finally {
      setIsSavingStructure(false);
    }
  };

  // Tab operations
  const addTab = () => {
    if (!structureConfig) return;
    const id = `tab_${Date.now()}`;
    const groupId = `group_${Date.now()}`;
    setStructureConfig({
      ...structureConfig,
      tabs: [...(structureConfig.tabs || []), { id, label: "New Tab", groups: [groupId] }],
      groups: [...structureConfig.groups, { id: groupId, label: "New Group", columns: 2, fields: [] }],
    });
  };

  const renameTab = (tabId: string, label: string) => {
    if (!structureConfig?.tabs) return;
    setStructureConfig({
      ...structureConfig,
      tabs: structureConfig.tabs.map(t => t.id === tabId ? { ...t, label } : t),
    });
  };

  const deleteTab = (tabId: string) => {
    if (!structureConfig?.tabs) return;
    const tab = structureConfig.tabs.find(t => t.id === tabId);
    if (!tab) return;
    if (structureConfig.tabs.length <= 1) {
      toast.error("Cannot delete the last tab");
      return;
    }
    setStructureConfig({
      ...structureConfig,
      tabs: structureConfig.tabs.filter(t => t.id !== tabId),
      groups: structureConfig.groups.filter(g => !tab.groups.includes(g.id)),
    });
  };

  // Group operations
  const addGroup = (tabId: string) => {
    if (!structureConfig?.tabs) return;
    const groupId = `group_${Date.now()}`;
    setStructureConfig({
      ...structureConfig,
      tabs: structureConfig.tabs.map(t =>
        t.id === tabId ? { ...t, groups: [...t.groups, groupId] } : t
      ),
      groups: [...structureConfig.groups, { id: groupId, label: "New Group", columns: 2, fields: [] }],
    });
  };

  const updateGroup = (groupId: string, updates: Partial<FormGroup>) => {
    if (!structureConfig) return;
    setStructureConfig({
      ...structureConfig,
      groups: structureConfig.groups.map(g =>
        g.id === groupId ? { ...g, ...updates } : g
      ),
    });
  };

  const deleteGroup = (tabId: string, groupId: string) => {
    if (!structureConfig?.tabs) return;
    const tab = structureConfig.tabs.find(t => t.id === tabId);
    if (!tab || tab.groups.length <= 1) {
      toast.error("Each tab needs at least one group");
      return;
    }
    setStructureConfig({
      ...structureConfig,
      tabs: structureConfig.tabs.map(t =>
        t.id === tabId ? { ...t, groups: t.groups.filter(g => g !== groupId) } : t
      ),
      groups: structureConfig.groups.filter(g => g.id !== groupId),
    });
  };

  // Field assignment
  const toggleFieldInGroup = (groupId: string, fieldKey: string) => {
    if (!structureConfig) return;
    const group = structureConfig.groups.find(g => g.id === groupId);
    if (!group) return;
    const fields = group.fields.includes(fieldKey)
      ? group.fields.filter(f => f !== fieldKey)
      : [...group.fields, fieldKey];
    updateGroup(groupId, { fields });
  };

  const getAssignedFields = (): Set<string> => {
    if (!structureConfig) return new Set();
    const assigned = new Set<string>();
    for (const group of structureConfig.groups) {
      for (const f of group.fields) assigned.add(f);
    }
    return assigned;
  };

  // Field override
  const updateFieldOverride = (fieldKey: string, override: Partial<FieldOverride>) => {
    if (!structureConfig) return;
    const existing = structureConfig.field_overrides[fieldKey] || {};
    setStructureConfig({
      ...structureConfig,
      field_overrides: {
        ...structureConfig.field_overrides,
        [fieldKey]: { ...existing, ...override },
      },
    });
  };

  // === Render structure editor ===
  const renderStructureEditor = (layout: FormLayout) => {
    if (editingStructure !== layout.id || !structureConfig) {
      return renderLayoutPreview(layout);
    }

    const assignedFields = getAssignedFields();

    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-muted-foreground">Editing Structure</span>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={cancelEditingStructure} disabled={isSavingStructure}>
              <X className="h-4 w-4 mr-1" /> Cancel
            </Button>
            <Button size="sm" onClick={saveStructure} disabled={isSavingStructure}>
              <Save className="h-4 w-4 mr-1" /> {isSavingStructure ? "Saving..." : "Save"}
            </Button>
          </div>
        </div>

        {/* Tabs */}
        {(structureConfig.tabs || []).map((tab) => (
          <div key={tab.id} className="border rounded-lg overflow-hidden">
            {/* Tab header */}
            <div className="flex items-center gap-2 p-3 bg-muted/50">
              <PanelTop className="h-4 w-4 text-muted-foreground shrink-0" />
              <Input
                value={tab.label}
                onChange={(e) => renameTab(tab.id, e.target.value)}
                className="h-7 text-sm font-medium max-w-[200px]"
              />
              <div className="ml-auto flex items-center gap-1">
                <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => addGroup(tab.id)}>
                  <FolderPlus className="h-3 w-3 mr-1" /> Group
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-destructive hover:text-destructive"
                  onClick={() => deleteTab(tab.id)}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            </div>

            {/* Groups in tab */}
            <div className="p-3 space-y-3">
              {tab.groups.map((groupId) => {
                const group = structureConfig.groups.find(g => g.id === groupId);
                if (!group) return null;
                return (
                  <div key={groupId} className="border rounded-md p-3 space-y-3">
                    {/* Group header */}
                    <div className="flex items-center gap-2 flex-wrap">
                      <FolderPlus className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      <Input
                        value={group.label}
                        onChange={(e) => updateGroup(groupId, { label: e.target.value })}
                        className="h-7 text-sm max-w-[180px]"
                      />
                      <Select
                        value={String(group.columns)}
                        onValueChange={(v) => updateGroup(groupId, { columns: Number(v) as 1 | 2 | 3 | 4 })}
                      >
                        <SelectTrigger className="h-7 w-[120px] text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {COLUMN_OPTIONS.map(opt => (
                            <SelectItem key={opt.value} value={String(opt.value)}>
                              <div className="flex items-center gap-1.5">
                                {opt.icon}
                                <span>{opt.label}</span>
                              </div>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <div className="flex items-center gap-1.5 ml-auto">
                        <Label className="text-xs text-muted-foreground">Collapsible</Label>
                        <Switch
                          checked={group.collapsible || false}
                          onCheckedChange={(c) => updateGroup(groupId, { collapsible: c })}
                          className="scale-75"
                        />
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-destructive hover:text-destructive"
                        onClick={() => deleteGroup(tab.id, groupId)}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>

                    {/* Field assignment */}
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">Assigned Fields</Label>
                      {availableFields.length === 0 ? (
                        <p className="text-xs text-muted-foreground italic">No custom fields created for this entity yet</p>
                      ) : (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-1 max-h-48 overflow-y-auto">
                          {availableFields.map(field => {
                            const isInThisGroup = group.fields.includes(field.field_key);
                            const isInOtherGroup = !isInThisGroup && assignedFields.has(field.field_key);
                            const override = structureConfig.field_overrides[field.field_key];
                            return (
                              <div key={field.field_key} className="flex items-center gap-2">
                                <Checkbox
                                  checked={isInThisGroup}
                                  disabled={isInOtherGroup}
                                  onCheckedChange={() => toggleFieldInGroup(groupId, field.field_key)}
                                  id={`${groupId}-${field.field_key}`}
                                />
                                <label
                                  htmlFor={`${groupId}-${field.field_key}`}
                                  className={`text-xs cursor-pointer flex-1 truncate ${isInOtherGroup ? "text-muted-foreground/50 line-through" : ""}`}
                                >
                                  {field.field_label}
                                </label>
                                {isInThisGroup && (
                                  <Select
                                    value={override?.width || "full"}
                                    onValueChange={(v) => updateFieldOverride(field.field_key, { width: v as FieldOverride["width"] })}
                                  >
                                    <SelectTrigger className="h-6 w-[80px] text-[10px]">
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      {WIDTH_OPTIONS.map(opt => (
                                        <SelectItem key={opt.value} value={opt.value!}>
                                          {opt.label}
                                        </SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}

        <Button variant="outline" size="sm" onClick={addTab} className="w-full">
          <Plus className="h-4 w-4 mr-1" /> Add Tab
        </Button>
      </div>
    );
  };

  const renderLayoutPreview = (layout: FormLayout) => {
    const config = layout.layout_config;
    if (!config) return null;
    const tabs = config.tabs || [];
    const groups = config.groups || [];

    return (
      <div className="space-y-2">
        {tabs.map((tab) => (
          <div key={tab.id} className="border rounded-md p-3 bg-muted/30">
            <div className="flex items-center gap-2 text-sm font-medium">
              <PanelTop className="h-4 w-4 text-muted-foreground" />
              {tab.label}
            </div>
            {tab.groups && tab.groups.length > 0 && (
              <div className="mt-2 ml-4 space-y-1">
                {tab.groups.map((groupId) => {
                  const group = groups.find(g => g.id === groupId);
                  if (!group) return null;
                  return (
                    <div key={groupId} className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <FolderPlus className="h-3 w-3" />
                      <span>{group.label} ({group.columns} col{group.columns > 1 ? "s" : ""})</span>
                      {group.collapsible && <Badge variant="outline" className="text-[10px]">Collapsible</Badge>}
                      {group.fields && group.fields.length > 0 && (
                        <Badge variant="secondary" className="text-xs">
                          {group.fields.length} field{group.fields.length > 1 ? "s" : ""}
                        </Badge>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <Select value={selectedEntityType} onValueChange={(v) => setSelectedEntityType(v as EntityType)}>
          <SelectTrigger className="w-full sm:w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(ENTITY_TYPE_LABELS) as EntityType[]).map((type) => (
              <SelectItem key={type} value={type}>
                <div className="flex items-center gap-2">
                  {ENTITY_ICONS[type]}
                  {ENTITY_TYPE_LABELS[type]}
                </div>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button onClick={() => handleOpenDialog()} className="w-full sm:w-auto">
          <Plus className="h-4 w-4 mr-2" />
          New Layout
        </Button>
      </div>

      <Card>
        <CardHeader className="pb-3 sm:pb-6">
          <CardTitle className="flex items-center gap-2 text-base sm:text-lg">
            <Layout className="h-4 w-4 sm:h-5 sm:w-5" />
            Form Layouts for {ENTITY_TYPE_LABELS[selectedEntityType]}
          </CardTitle>
          <CardDescription className="text-xs sm:text-sm">
            Organize form fields into tabs and groups with column layouts
          </CardDescription>
        </CardHeader>
        <CardContent className="px-3 sm:px-6">
          {isLoading ? (
            <div className="space-y-3">
              {[1, 2].map((i) => <Skeleton key={i} className="h-24 w-full" />)}
            </div>
          ) : layouts.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <Layout className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p>No form layouts yet</p>
              <p className="text-sm">Create your first custom layout to organize form fields</p>
            </div>
          ) : (
            <div className="space-y-3">
              {layouts.map((layout) => (
                <div key={layout.id} className="border rounded-lg">
                  <div
                    className="flex items-center justify-between p-3 sm:p-4 cursor-pointer hover:bg-muted/50"
                    onClick={() => setExpandedLayout(expandedLayout === layout.id ? null : layout.id)}
                  >
                    <div className="flex items-center gap-2 sm:gap-3 min-w-0">
                      {expandedLayout === layout.id ? (
                        <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                      ) : (
                        <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                      )}
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium text-sm sm:text-base truncate">{layout.layout_name}</span>
                          {layout.is_default && <Badge variant="secondary" className="text-xs">Default</Badge>}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Badge variant="outline" className="text-xs hidden sm:inline-flex">
                        {layout.layout_config?.tabs?.length || 0} tab{(layout.layout_config?.tabs?.length || 0) !== 1 ? "s" : ""}
                      </Badge>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                          <Button variant="ghost" size="icon" className="h-8 w-8">
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => handleOpenDialog(layout)}>
                            <Pencil className="mr-2 h-4 w-4" />
                            Rename
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => startEditingStructure(layout)}>
                            <Layout className="mr-2 h-4 w-4" />
                            Edit Structure
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => handleDelete(layout)} className="text-destructive">
                            <Trash2 className="mr-2 h-4 w-4" />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>
                  
                  {expandedLayout === layout.id && (
                    <div className="px-3 sm:px-4 pb-3 sm:pb-4 border-t pt-3">
                      {renderStructureEditor(layout)}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Create/Edit Dialog */}
      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent className="max-w-[95vw] sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editingLayout ? "Edit Layout" : "Create New Layout"}</DialogTitle>
            <DialogDescription>
              {editingLayout ? "Update the layout settings" : `Create a new form layout for ${ENTITY_TYPE_LABELS[selectedEntityType]}`}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="layout_name">Layout Name *</Label>
              <Input
                id="layout_name"
                value={formData.layout_name}
                onChange={(e) => setFormData({ ...formData, layout_name: e.target.value })}
                placeholder="e.g., Customer Form"
              />
            </div>
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label>Set as Default</Label>
                <p className="text-xs text-muted-foreground">This layout will be used by default</p>
              </div>
              <Switch
                checked={formData.is_default}
                onCheckedChange={(checked) => setFormData({ ...formData, is_default: checked })}
              />
            </div>
          </div>
          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button variant="outline" onClick={() => setShowDialog(false)} disabled={isSubmitting} className="w-full sm:w-auto">
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={isSubmitting} className="w-full sm:w-auto">
              {editingLayout ? "Update Layout" : "Create Layout"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
