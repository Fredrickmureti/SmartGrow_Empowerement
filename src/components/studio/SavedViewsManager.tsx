import { useState } from "react";
import { useSavedViews, SavedView, ViewType, VIEW_TYPE_LABELS, ViewConfig, ListViewConfig, KanbanViewConfig, ChartViewConfig, PivotViewConfig, CalendarViewConfig, GanttViewConfig } from "@/hooks/useSavedViews";
import { useAllEntityFields, ENTITY_TYPE_LABELS, EntityType } from "@/hooks/useEntityFields";
import { ViewConfigPanel } from "./ViewConfigPanel";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import {
  Plus,
  MoreHorizontal,
  Pencil,
  Trash2,
  List,
  LayoutGrid,
  PieChart,
  BarChart3,
  Star,
  Users,
  Package,
  FileSpreadsheet,
  FileText,
  ShoppingCart,
  Briefcase,
  Receipt,
  DollarSign,
  Calendar,
  GanttChart,
  Settings2,
  RefreshCw,
} from "lucide-react";
import { normalizeError } from "@/services/resilience";

const VIEW_TYPE_ICONS: Record<ViewType, React.ReactNode> = {
  list: <List className="h-4 w-4" />,
  kanban: <LayoutGrid className="h-4 w-4" />,
  pivot: <BarChart3 className="h-4 w-4" />,
  chart: <PieChart className="h-4 w-4" />,
  calendar: <Calendar className="h-4 w-4" />,
  gantt: <GanttChart className="h-4 w-4" />,
};

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

function getDefaultConfigForType(viewType: ViewType): ViewConfig {
  switch (viewType) {
    case "list": return { columns: [], sort: undefined, filters: [], groupBy: undefined } as ListViewConfig;
    case "kanban": return { groupBy: "", columns: [], cardFields: [] } as KanbanViewConfig;
    case "chart": return { type: "bar", xAxis: "", yAxis: "" } as ChartViewConfig;
    case "pivot": return { rows: [], cols: [], values: [] } as PivotViewConfig;
    case "calendar": return { dateField: "", titleField: "" } as CalendarViewConfig;
    case "gantt": return { startField: "", endField: "", nameField: "" } as GanttViewConfig;
    default: return { columns: [] } as ListViewConfig;
  }
}

interface SavedViewsManagerProps {
  entityType?: EntityType;
}

export function SavedViewsManager({ entityType: initialEntityType }: SavedViewsManagerProps) {
  const [selectedEntityType, setSelectedEntityType] = useState<EntityType>(initialEntityType || "contact");
  const { views, isLoading, createView, updateView, deleteView } = useSavedViews(selectedEntityType);
  
  const [showDialog, setShowDialog] = useState(false);
  const [showConfigDialog, setShowConfigDialog] = useState(false);
  const [editingView, setEditingView] = useState<SavedView | null>(null);
  const [configuringView, setConfiguringView] = useState<SavedView | null>(null);
  const [viewConfig, setViewConfig] = useState<ViewConfig>(getDefaultConfigForType("list"));
  const [isSubmitting, setIsSubmitting] = useState(false);
  
  const [formData, setFormData] = useState({
    view_name: "",
    view_type: "list" as ViewType,
    is_default: false,
    is_shared: true,
  });

  const resetForm = () => {
    setFormData({ view_name: "", view_type: "list", is_default: false, is_shared: true });
    setEditingView(null);
  };

  const handleOpenDialog = (view?: SavedView) => {
    if (view) {
      setEditingView(view);
      setFormData({
        view_name: view.view_name,
        view_type: view.view_type,
        is_default: view.is_default,
        is_shared: view.is_shared,
      });
    } else {
      resetForm();
    }
    setShowDialog(true);
  };

  const handleSubmit = async () => {
    if (!formData.view_name.trim()) {
      toast.error("View name is required");
      return;
    }
    setIsSubmitting(true);
    try {
      if (editingView) {
        await updateView(editingView.id, {
          view_name: formData.view_name,
          is_default: formData.is_default,
          is_shared: formData.is_shared,
        });
      } else {
        const config = getDefaultConfigForType(formData.view_type);
        const newView = await createView(
          formData.view_name,
          formData.view_type,
          config,
          { isShared: formData.is_shared, isDefault: formData.is_default }
        );
        // Open config dialog for the new view
        if (newView) {
          setConfiguringView(newView as SavedView);
          setViewConfig(config);
          setShowConfigDialog(true);
        }
      }
      setShowDialog(false);
      resetForm();
    } catch (error: any) {
      toast.error(normalizeError(error).message || "Failed to save view");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleOpenConfig = (view: SavedView) => {
    setConfiguringView(view);
    setViewConfig(view.view_config || getDefaultConfigForType(view.view_type));
    setShowConfigDialog(true);
  };

  const handleSaveConfig = async () => {
    if (!configuringView) return;

    // Validate view config fields
    const warnings = validateViewConfig(configuringView.view_type, viewConfig);
    if (warnings.length > 0) {
      toast.warning(`View saved with warnings: ${warnings.join("; ")}`);
    }

    setIsSubmitting(true);
    try {
      await updateView(configuringView.id, { view_config: viewConfig } as any);
      setShowConfigDialog(false);
      setConfiguringView(null);
      toast.success("View configuration saved");
    } catch (error: any) {
      toast.error(normalizeError(error).message || "Failed to save configuration");
    } finally {
      setIsSubmitting(false);
    }
  };

  /**
   * Validate that view config has required fields set for non-trivial view types.
   * Returns an array of warning messages.
   */
  const validateViewConfig = (viewType: ViewType, config: ViewConfig): string[] => {
    const warnings: string[] = [];
    switch (viewType) {
      case "list": {
        const lc = config as ListViewConfig;
        if (!lc.columns || lc.columns.length === 0) {
          warnings.push("No columns configured — default columns will be used");
        }
        break;
      }
      case "kanban": {
        const kc = config as KanbanViewConfig;
        if (!kc.groupBy) warnings.push("Kanban view requires a 'Group By' field");
        break;
      }
      case "chart": {
        const cc = config as ChartViewConfig;
        if (!cc.xAxis) warnings.push("Chart requires an X-axis field");
        if (!cc.yAxis) warnings.push("Chart requires a Y-axis field");
        break;
      }
      case "calendar": {
        const cal = config as CalendarViewConfig;
        if (!cal.dateField) warnings.push("Calendar requires a date field");
        if (!cal.titleField) warnings.push("Calendar requires a title field");
        break;
      }
      case "gantt": {
        const gc = config as GanttViewConfig;
        if (!gc.startField) warnings.push("Gantt requires a start date field");
        if (!gc.endField) warnings.push("Gantt requires an end date field");
        if (!gc.nameField) warnings.push("Gantt requires a name field");
        break;
      }
    }
    return warnings;
  };

  const handleDelete = async (view: SavedView) => {
    if (!confirm(`Delete "${view.view_name}"?`)) return;
    try {
      await deleteView(view.id);
    } catch (error: any) {
      toast.error(normalizeError(error).message || "Failed to delete view");
    }
  };

  const handleSetDefault = async (view: SavedView) => {
    try {
      await updateView(view.id, { is_default: true });
    } catch (error: any) {
      toast.error(normalizeError(error).message || "Failed to set default view");
    }
  };

  const getConfigSummary = (view: SavedView): string => {
    const cfg = view.view_config;
    if (!cfg) return "Not configured";
    switch (view.view_type) {
      case "list": {
        const lc = cfg as ListViewConfig;
        return lc.columns?.length ? `${lc.columns.length} columns` : "No columns set";
      }
      case "kanban": {
        const kc = cfg as KanbanViewConfig;
        return kc.groupBy ? `Grouped by: ${kc.groupBy}` : "No grouping set";
      }
      case "chart": {
        const cc = cfg as ChartViewConfig;
        return cc.xAxis && cc.yAxis ? `${cc.type}: ${cc.xAxis} × ${cc.yAxis}` : "Not configured";
      }
      case "pivot": {
        const pc = cfg as PivotViewConfig;
        return pc.rows?.length ? `${pc.rows.length} rows, ${pc.values?.length || 0} values` : "Not configured";
      }
      case "calendar": {
        const cal = cfg as CalendarViewConfig;
        return cal.dateField ? `Date: ${cal.dateField}` : "Not configured";
      }
      case "gantt": {
        const gc = cfg as GanttViewConfig;
        return gc.startField ? `${gc.startField} → ${gc.endField}` : "Not configured";
      }
      default: return "—";
    }
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
          New View
        </Button>
      </div>

      <Card>
        <CardHeader className="pb-3 sm:pb-6">
          <CardTitle className="flex items-center gap-2 text-base sm:text-lg">
            <BarChart3 className="h-4 w-4 sm:h-5 sm:w-5" />
            Saved Views for {ENTITY_TYPE_LABELS[selectedEntityType]}
          </CardTitle>
          <CardDescription className="text-xs sm:text-sm">
            Create and configure custom list, kanban, pivot, and chart views
          </CardDescription>
        </CardHeader>
        <CardContent className="px-3 sm:px-6">
          {isLoading ? (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : views.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <BarChart3 className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p>No saved views yet</p>
              <p className="text-sm">Create your first custom view to get started</p>
            </div>
          ) : (
            <>
              {/* Mobile Card Layout */}
              <div className="md:hidden space-y-3">
                {views.map((view) => (
                  <Card key={view.id} className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          {VIEW_TYPE_ICONS[view.view_type]}
                          <span className="font-medium text-sm">{view.view_name}</span>
                          {view.is_default && <Star className="h-4 w-4 text-yellow-500 fill-yellow-500" />}
                        </div>
                        <div className="flex flex-wrap gap-1 mt-1.5">
                          <Badge variant="outline" className="text-xs">{VIEW_TYPE_LABELS[view.view_type]}</Badge>
                          <Badge variant="secondary" className="text-xs">{view.is_shared ? "Shared" : "Private"}</Badge>
                        </div>
                        <p className="text-xs text-muted-foreground mt-1">{getConfigSummary(view)}</p>
                      </div>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0">
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => handleOpenConfig(view)}>
                            <Settings2 className="mr-2 h-4 w-4" />
                            Configure
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => handleOpenDialog(view)}>
                            <Pencil className="mr-2 h-4 w-4" />
                            Edit
                          </DropdownMenuItem>
                          {!view.is_default && (
                            <DropdownMenuItem onClick={() => handleSetDefault(view)}>
                              <Star className="mr-2 h-4 w-4" />
                              Set as Default
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem onClick={() => handleDelete(view)} className="text-destructive">
                            <Trash2 className="mr-2 h-4 w-4" />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </Card>
                ))}
              </div>

              {/* Desktop Table Layout */}
              <div className="hidden md:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Configuration</TableHead>
                      <TableHead>Shared</TableHead>
                      <TableHead className="w-20">Default</TableHead>
                      <TableHead className="w-12"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {views.map((view) => (
                      <TableRow key={view.id}>
                        <TableCell className="font-medium">{view.view_name}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className="flex items-center gap-1 w-fit">
                            {VIEW_TYPE_ICONS[view.view_type]}
                            {VIEW_TYPE_LABELS[view.view_type]}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <button
                            onClick={() => handleOpenConfig(view)}
                            className="text-xs text-muted-foreground hover:text-foreground hover:underline cursor-pointer"
                          >
                            {getConfigSummary(view)}
                          </button>
                        </TableCell>
                        <TableCell>
                          <Badge variant={view.is_shared ? "secondary" : "outline"}>
                            {view.is_shared ? "Shared" : "Private"}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {view.is_default && <Star className="h-4 w-4 text-yellow-500 fill-yellow-500" />}
                        </TableCell>
                        <TableCell>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon">
                                <MoreHorizontal className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={() => handleOpenConfig(view)}>
                                <Settings2 className="mr-2 h-4 w-4" />
                                Configure
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => handleOpenDialog(view)}>
                                <Pencil className="mr-2 h-4 w-4" />
                                Edit
                              </DropdownMenuItem>
                              {!view.is_default && (
                                <DropdownMenuItem onClick={() => handleSetDefault(view)}>
                                  <Star className="mr-2 h-4 w-4" />
                                  Set as Default
                                </DropdownMenuItem>
                              )}
                              <DropdownMenuItem onClick={() => handleDelete(view)} className="text-destructive">
                                <Trash2 className="mr-2 h-4 w-4" />
                                Delete
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Create/Edit Dialog */}
      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent className="max-w-[95vw] sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editingView ? "Edit View" : "Create New View"}</DialogTitle>
            <DialogDescription>
              {editingView ? "Update the view settings" : `Create a new saved view for ${ENTITY_TYPE_LABELS[selectedEntityType]}`}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="view_name">View Name *</Label>
              <Input
                id="view_name"
                value={formData.view_name}
                onChange={(e) => setFormData({ ...formData, view_name: e.target.value })}
                placeholder="e.g., Active Customers"
              />
            </div>
            {!editingView && (
              <div className="space-y-2">
                <Label htmlFor="view_type">View Type</Label>
                <Select
                  value={formData.view_type}
                  onValueChange={(v) => setFormData({ ...formData, view_type: v as ViewType })}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {(Object.keys(VIEW_TYPE_LABELS) as ViewType[]).map((type) => (
                      <SelectItem key={type} value={type}>
                        <div className="flex items-center gap-2">
                          {VIEW_TYPE_ICONS[type]}
                          {VIEW_TYPE_LABELS[type]}
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label>Share with Team</Label>
                <p className="text-xs text-muted-foreground">Other team members can use this view</p>
              </div>
              <Switch
                checked={formData.is_shared}
                onCheckedChange={(checked) => setFormData({ ...formData, is_shared: checked })}
              />
            </div>
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label>Set as Default</Label>
                <p className="text-xs text-muted-foreground">This view will be shown by default</p>
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
              {editingView ? "Update View" : "Create View"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* View Configuration Dialog */}
      <Dialog open={showConfigDialog} onOpenChange={setShowConfigDialog}>
        <DialogContent className="max-w-[95vw] sm:max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Settings2 className="h-5 w-5" />
              Configure {configuringView ? VIEW_TYPE_LABELS[configuringView.view_type] : ""} View
            </DialogTitle>
            <DialogDescription>
              {configuringView?.view_name} — Set up fields, columns, and display options
            </DialogDescription>
          </DialogHeader>
          
          {configuringView && (
            <div className="py-2">
              <ViewConfigPanel
                viewType={configuringView.view_type}
                entityType={selectedEntityType}
                config={viewConfig}
                onChange={setViewConfig}
              />
            </div>
          )}

          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button variant="outline" onClick={() => setShowConfigDialog(false)} disabled={isSubmitting} className="w-full sm:w-auto">
              Cancel
            </Button>
            <Button onClick={handleSaveConfig} disabled={isSubmitting} className="w-full sm:w-auto">
              {isSubmitting ? "Saving..." : "Save Configuration"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
