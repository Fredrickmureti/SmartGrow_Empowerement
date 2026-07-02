import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  AlertTriangle,
  CheckCircle,
  Clock,
  FileText,
  Plus,
  Calendar,
  Filter,
  Shield,
  ClipboardList,
  Trash2,
  Pencil,
  Loader2,
  Building2,
  Receipt,
  Scale,
} from "lucide-react";
import { format, differenceInDays, isPast, addDays } from "date-fns";
import { cn } from "@/lib/utils";
import { useComplianceChecklist, ComplianceItem } from "@/hooks/useReportScheduling";
import { toast } from "sonner";

const CATEGORY_CONFIG: Record<
  ComplianceItem["category"],
  { label: string; icon: React.ReactNode; color: string }
> = {
  tax: { label: "Tax", icon: <Receipt className="h-4 w-4" />, color: "bg-blue-500" },
  audit: { label: "Audit", icon: <FileText className="h-4 w-4" />, color: "bg-purple-500" },
  regulatory: { label: "Regulatory", icon: <Scale className="h-4 w-4" />, color: "bg-orange-500" },
  internal: { label: "Internal", icon: <Building2 className="h-4 w-4" />, color: "bg-green-500" },
};

const STATUS_CONFIG: Record<
  ComplianceItem["status"],
  { label: string; variant: "default" | "secondary" | "destructive" | "outline" }
> = {
  pending: { label: "Pending", variant: "outline" },
  in_progress: { label: "In Progress", variant: "secondary" },
  completed: { label: "Completed", variant: "default" },
  overdue: { label: "Overdue", variant: "destructive" },
};

export function ComplianceDashboard() {
  const {
    items,
    isLoading,
    createItem,
    updateItem,
    completeItem,
    deleteItem,
    stats,
    pendingItems,
    overdueItems,
  } = useComplianceChecklist();

  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [selectedItem, setSelectedItem] = useState<ComplianceItem | null>(null);
  const [filterCategory, setFilterCategory] = useState<string>("all");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [newItem, setNewItem] = useState({
    category: "tax" as ComplianceItem["category"],
    title: "",
    description: "",
    due_date: "",
    frequency: "one_time" as ComplianceItem["frequency"],
    reminder_days: 7,
    status: "pending" as ComplianceItem["status"],
    notes: "",
    assigned_to: null as string | null,
    attachments: [] as Array<{ name: string; url: string }>,
  });

  const filteredItems = items.filter(
    (item) => filterCategory === "all" || item.category === filterCategory
  );

  const completionRate = stats.total > 0
    ? Math.round((stats.completed / stats.total) * 100)
    : 0;

  const handleCreate = async () => {
    if (!newItem.title.trim()) {
      toast.error("Title is required");
      return;
    }

    setIsSubmitting(true);
    try {
      await createItem({
        ...newItem,
        due_date: newItem.due_date || null,
        business_id: null,
      });
      setShowCreateDialog(false);
      setNewItem({
        category: "tax",
        title: "",
        description: "",
        due_date: "",
        frequency: "one_time",
        reminder_days: 7,
        status: "pending",
        notes: "",
        assigned_to: null,
        attachments: [],
      });
    } catch (error) {
      toast.error("Failed to create item");
    } finally {
      setIsSubmitting(false);
    }
  };

  const getDueDateInfo = (dueDate: string | null) => {
    if (!dueDate) return null;
    const date = new Date(dueDate);
    const daysUntil = differenceInDays(date, new Date());
    const isOverdue = isPast(date) && daysUntil < 0;

    return { date, daysUntil, isOverdue };
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Pending</p>
                <p className="text-2xl font-bold">{stats.pending}</p>
              </div>
              <Clock className="h-8 w-8 text-muted-foreground" />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Overdue</p>
                <p className="text-2xl font-bold text-destructive">{stats.overdue}</p>
              </div>
              <AlertTriangle className="h-8 w-8 text-destructive" />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Due This Week</p>
                <p className="text-2xl font-bold text-orange-600">{stats.dueSoon}</p>
              </div>
              <Calendar className="h-8 w-8 text-orange-600" />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Completed</p>
                <p className="text-2xl font-bold text-green-600">{stats.completed}</p>
              </div>
              <CheckCircle className="h-8 w-8 text-green-600" />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Progress Overview */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Shield className="h-5 w-5 text-primary" />
              <CardTitle>Compliance Progress</CardTitle>
            </div>
            <Badge variant="outline">{completionRate}% Complete</Badge>
          </div>
        </CardHeader>
        <CardContent>
          <Progress value={completionRate} className="h-3" />
          <div className="flex justify-between mt-2 text-sm text-muted-foreground">
            <span>{stats.completed} of {stats.total} items completed</span>
            <span>{stats.pending + stats.inProgress} remaining</span>
          </div>
        </CardContent>
      </Card>

      {/* Alerts Section */}
      {(overdueItems.length > 0 || stats.dueSoon > 0) && (
        <Card className="border-destructive/50 bg-destructive/5">
          <CardHeader className="pb-2">
            <CardTitle className="text-destructive flex items-center gap-2">
              <AlertTriangle className="h-5 w-5" />
              Attention Required
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {overdueItems.slice(0, 3).map((item) => (
              <div
                key={item.id}
                className="flex items-center justify-between p-2 rounded-md bg-background"
              >
                <div className="flex items-center gap-2">
                  <Badge variant="destructive">Overdue</Badge>
                  <span className="font-medium">{item.title}</span>
                </div>
                <Button size="sm" onClick={() => setSelectedItem(item)}>
                  View
                </Button>
              </div>
            ))}
            {pendingItems
              .filter((item) => {
                const info = getDueDateInfo(item.due_date);
                return info && info.daysUntil >= 0 && info.daysUntil <= 7;
              })
              .slice(0, 2)
              .map((item) => (
                <div
                  key={item.id}
                  className="flex items-center justify-between p-2 rounded-md bg-background"
                >
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary">Due Soon</Badge>
                    <span className="font-medium">{item.title}</span>
                    <span className="text-sm text-muted-foreground">
                      (Due: {format(new Date(item.due_date!), "MMM d")})
                    </span>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => completeItem(item.id)}>
                    Mark Complete
                  </Button>
                </div>
              ))}
          </CardContent>
        </Card>
      )}

      {/* Main Content */}
      <Card>
        <CardHeader>
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div className="flex items-center gap-2">
              <ClipboardList className="h-5 w-5 text-primary" />
              <CardTitle>Compliance Checklist</CardTitle>
            </div>
            <div className="flex gap-2">
              <Select value={filterCategory} onValueChange={setFilterCategory}>
                <SelectTrigger className="w-[140px]">
                  <Filter className="h-4 w-4 mr-2" />
                  <SelectValue placeholder="Filter" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Categories</SelectItem>
                  {Object.entries(CATEGORY_CONFIG).map(([key, { label }]) => (
                    <SelectItem key={key} value={key}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button onClick={() => setShowCreateDialog(true)}>
                <Plus className="h-4 w-4 mr-2" />
                Add Item
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="active">
            <TabsList className="mb-4">
              <TabsTrigger value="active">
                Active ({stats.pending + stats.inProgress + stats.overdue})
              </TabsTrigger>
              <TabsTrigger value="completed">
                Completed ({stats.completed})
              </TabsTrigger>
            </TabsList>

            <TabsContent value="active" className="space-y-2">
              {filteredItems
                .filter((item) => item.status !== "completed")
                .map((item) => (
                  <ComplianceItemRow
                    key={item.id}
                    item={item}
                    onComplete={() => completeItem(item.id)}
                    onEdit={() => setSelectedItem(item)}
                    onDelete={() => deleteItem(item.id)}
                    getDueDateInfo={getDueDateInfo}
                  />
                ))}
              {filteredItems.filter((item) => item.status !== "completed").length === 0 && (
                <div className="text-center py-8 text-muted-foreground">
                  <CheckCircle className="h-12 w-12 mx-auto mb-2 opacity-50" />
                  <p>All caught up! No active compliance items.</p>
                </div>
              )}
            </TabsContent>

            <TabsContent value="completed" className="space-y-2">
              {filteredItems
                .filter((item) => item.status === "completed")
                .map((item) => (
                  <ComplianceItemRow
                    key={item.id}
                    item={item}
                    onEdit={() => setSelectedItem(item)}
                    onDelete={() => deleteItem(item.id)}
                    getDueDateInfo={getDueDateInfo}
                  />
                ))}
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      {/* Create Dialog */}
      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Add Compliance Item</DialogTitle>
            <DialogDescription>
              Create a new compliance checklist item
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Category</Label>
                <Select
                  value={newItem.category}
                  onValueChange={(v) =>
                    setNewItem({ ...newItem, category: v as ComplianceItem["category"] })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(CATEGORY_CONFIG).map(([key, { label, icon }]) => (
                      <SelectItem key={key} value={key}>
                        <div className="flex items-center gap-2">
                          {icon}
                          {label}
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Frequency</Label>
                <Select
                  value={newItem.frequency || "one_time"}
                  onValueChange={(v) =>
                    setNewItem({ ...newItem, frequency: v as ComplianceItem["frequency"] })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="one_time">One-time</SelectItem>
                    <SelectItem value="monthly">Monthly</SelectItem>
                    <SelectItem value="quarterly">Quarterly</SelectItem>
                    <SelectItem value="annually">Annually</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-2">
              <Label>Title *</Label>
              <Input
                value={newItem.title}
                onChange={(e) => setNewItem({ ...newItem, title: e.target.value })}
                placeholder="e.g., File VAT Return"
              />
            </div>
            <div className="space-y-2">
              <Label>Description</Label>
              <Textarea
                value={newItem.description}
                onChange={(e) => setNewItem({ ...newItem, description: e.target.value })}
                placeholder="Additional details..."
                rows={2}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Due Date</Label>
                <Input
                  type="date"
                  value={newItem.due_date}
                  onChange={(e) => setNewItem({ ...newItem, due_date: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>Reminder (days before)</Label>
                <Input
                  type="number"
                  value={newItem.reminder_days}
                  onChange={(e) =>
                    setNewItem({ ...newItem, reminder_days: parseInt(e.target.value) || 7 })
                  }
                  min={1}
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreateDialog(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreate} disabled={isSubmitting}>
              {isSubmitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Create Item
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface ComplianceItemRowProps {
  item: ComplianceItem;
  onComplete?: () => void;
  onEdit: () => void;
  onDelete: () => void;
  getDueDateInfo: (dueDate: string | null) => { date: Date; daysUntil: number; isOverdue: boolean } | null;
}

function ComplianceItemRow({ item, onComplete, onEdit, onDelete, getDueDateInfo }: ComplianceItemRowProps) {
  const categoryConfig = CATEGORY_CONFIG[item.category];
  const statusConfig = STATUS_CONFIG[item.status];
  const dueDateInfo = getDueDateInfo(item.due_date);

  return (
    <div className="flex items-center justify-between p-3 rounded-lg border bg-card hover:bg-muted/50 transition-colors">
      <div className="flex items-center gap-3">
        <div className={cn("p-2 rounded-md", categoryConfig.color, "text-white")}>
          {categoryConfig.icon}
        </div>
        <div>
          <div className="flex items-center gap-2">
            <span className="font-medium">{item.title}</span>
            <Badge variant={statusConfig.variant}>{statusConfig.label}</Badge>
            <Badge variant="outline">{categoryConfig.label}</Badge>
          </div>
          {item.description && (
            <p className="text-sm text-muted-foreground line-clamp-1">{item.description}</p>
          )}
          {dueDateInfo && (
            <p className={cn(
              "text-xs mt-1",
              dueDateInfo.isOverdue ? "text-destructive" : 
              dueDateInfo.daysUntil <= 7 ? "text-orange-600" : "text-muted-foreground"
            )}>
              {dueDateInfo.isOverdue
                ? `Overdue by ${Math.abs(dueDateInfo.daysUntil)} days`
                : dueDateInfo.daysUntil === 0
                ? "Due today"
                : `Due in ${dueDateInfo.daysUntil} days (${format(dueDateInfo.date, "MMM d, yyyy")})`}
            </p>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1">
        {onComplete && item.status !== "completed" && (
          <Button variant="ghost" size="sm" onClick={onComplete}>
            <CheckCircle className="h-4 w-4 mr-1" />
            Complete
          </Button>
        )}
        <Button variant="ghost" size="icon" onClick={onEdit}>
          <Pencil className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="icon" className="text-destructive" onClick={onDelete}>
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
