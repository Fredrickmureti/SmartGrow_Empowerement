import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useCustomerGroups, CustomerGroup } from "@/hooks/useCustomerGroups";
import { useToast } from "@/hooks/use-toast";
import { Plus, Pencil, Trash2, Users, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { normalizeError } from "@/services/resilience";

interface CustomerGroupsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CustomerGroupsDialog({ open, onOpenChange }: CustomerGroupsDialogProps) {
  const { customerGroups, isLoading, createCustomerGroup, updateCustomerGroup, deleteCustomerGroup } = useCustomerGroups();
  const { toast } = useToast();

  const [showForm, setShowForm] = useState(false);
  const [editingGroup, setEditingGroup] = useState<CustomerGroup | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formData, setFormData] = useState({
    name: "",
    description: "",
    discount_percent: 0,
    is_active: true,
  });

  const resetForm = () => {
    setFormData({ name: "", description: "", discount_percent: 0, is_active: true });
    setEditingGroup(null);
    setShowForm(false);
  };

  const handleEdit = (group: CustomerGroup) => {
    setEditingGroup(group);
    setFormData({
      name: group.name,
      description: group.description || "",
      discount_percent: group.discount_percent,
      is_active: group.is_active,
    });
    setShowForm(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.name.trim()) {
      toast({ title: "Name is required", variant: "destructive" });
      return;
    }

    setIsSubmitting(true);
    try {
      if (editingGroup) {
        await updateCustomerGroup(editingGroup.id, formData);
        toast({ title: "Customer group updated" });
      } else {
        await createCustomerGroup(formData);
        toast({ title: "Customer group created" });
      }
      resetForm();
    } catch (error: any) {
      toast({
        title: editingGroup ? "Error updating group" : "Error creating group",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteCustomerGroup(id);
      toast({ title: "Customer group deleted" });
    } catch (error: any) {
      toast({
        title: "Error deleting group",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
       <DialogContent
          className="max-w-2xl max-h-[90vh] overflow-y-auto w-[calc(100vw-2rem)] sm:w-auto"
          onPointerDownOutside={(e) => e.stopPropagation()}
          onEscapeKeyDown={(e) => e.stopPropagation()}
          onInteractOutside={(e) => e.stopPropagation()}
        >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base sm:text-lg">
            <Users className="h-4 w-4 sm:h-5 sm:w-5" />
            Manage Customer Groups
          </DialogTitle>
          <DialogDescription className="text-xs sm:text-sm">
            Create and manage customer groups for better organization and pricing.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {!showForm && (
            <Button onClick={() => setShowForm(true)} size="sm" className="gap-2">
              <Plus className="h-4 w-4" />
              Add Group
            </Button>
          )}

          {showForm && (
            <form onSubmit={handleSubmit} className="space-y-3 sm:space-y-4 border rounded-lg p-3 sm:p-4 bg-muted/50">
              <div className="grid gap-3 sm:gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="name" className="text-xs sm:text-sm">Name *</Label>
                  <Input
                    id="name"
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    placeholder="e.g., Wholesale"
                    className="h-8 sm:h-10 text-sm"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="discount" className="text-xs sm:text-sm">Default Discount (%)</Label>
                  <Input
                    id="discount"
                    type="number"
                    min="0"
                    max="100"
                    step="0.01"
                    value={formData.discount_percent}
                    onChange={(e) => setFormData({ ...formData, discount_percent: parseFloat(e.target.value) || 0 })}
                    className="h-8 sm:h-10 text-sm"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="description" className="text-xs sm:text-sm">Description</Label>
                <Textarea
                  id="description"
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  placeholder="Optional description..."
                  className="text-sm min-h-[60px] sm:min-h-[80px]"
                />
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Switch
                    id="is_active"
                    checked={formData.is_active}
                    onCheckedChange={(checked) => setFormData({ ...formData, is_active: checked })}
                  />
                  <Label htmlFor="is_active" className="text-xs sm:text-sm">Active</Label>
                </div>
                <div className="flex gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={resetForm}>
                    Cancel
                  </Button>
                  <Button type="submit" size="sm" disabled={isSubmitting}>
                    {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    {editingGroup ? "Update" : "Create"}
                  </Button>
                </div>
              </div>
            </form>
          )}

          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : customerGroups.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground text-sm">
              No customer groups yet. Create your first one!
            </div>
          ) : (
            <>
              {/* Mobile: card layout */}
              <div className="space-y-2 sm:hidden">
                {customerGroups.map((group) => (
                  <div key={group.id} className="flex items-center justify-between border rounded-lg p-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-sm truncate">{group.name}</span>
                        <Badge variant={group.is_active ? "default" : "secondary"} className="text-[10px] px-1.5 py-0">
                          {group.is_active ? "Active" : "Inactive"}
                        </Badge>
                      </div>
                      <div className="flex gap-3 mt-1 text-xs text-muted-foreground">
                        {group.description && <span className="truncate">{group.description}</span>}
                        {group.discount_percent > 0 && <span className="shrink-0">{group.discount_percent}% off</span>}
                      </div>
                    </div>
                    <div className="flex gap-0.5 shrink-0 ml-2">
                      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => handleEdit(group)}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive" onClick={() => handleDelete(group.id)}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>

              {/* Desktop: table layout */}
              <div className="rounded-md border hidden sm:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Description</TableHead>
                      <TableHead>Discount</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="w-[100px]"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {customerGroups.map((group) => (
                      <TableRow key={group.id}>
                        <TableCell className="font-medium">{group.name}</TableCell>
                        <TableCell className="text-muted-foreground">
                          {group.description || "—"}
                        </TableCell>
                        <TableCell>
                          {group.discount_percent > 0 ? `${group.discount_percent}%` : "—"}
                        </TableCell>
                        <TableCell>
                          <Badge variant={group.is_active ? "default" : "secondary"}>
                            {group.is_active ? "Active" : "Inactive"}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <div className="flex gap-1">
                            <Button variant="ghost" size="icon" onClick={() => handleEdit(group)}>
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button variant="ghost" size="icon" onClick={() => handleDelete(group.id)} className="text-destructive hover:text-destructive">
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
