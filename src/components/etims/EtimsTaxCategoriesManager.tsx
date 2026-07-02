import { useState } from "react";
import { useEtimsTaxCategories, EtimsTaxCategory } from "@/hooks/useEtimsTaxCategories";
import { useOrganization } from "@/hooks/useOrganization";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Loader2, Plus, Pencil, Trash2, RefreshCw, FileCheck2 } from "lucide-react";
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

interface FormData {
  code: string;
  name: string;
  rate: number;
  description: string;
  is_active: boolean;
  sort_order: number;
}

const initialFormData: FormData = {
  code: "",
  name: "",
  rate: 0,
  description: "",
  is_active: true,
  sort_order: 0,
};

export function EtimsTaxCategoriesManager() {
  const {
    categories,
    isLoading,
    createCategory,
    updateCategory,
    deleteCategory,
    initializeDefaults,
    isCreating,
    isUpdating,
  } = useEtimsTaxCategories();
  const { userRole } = useOrganization();

  const [showDialog, setShowDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [editingCategory, setEditingCategory] = useState<EtimsTaxCategory | null>(null);
  const [deletingCategory, setDeletingCategory] = useState<EtimsTaxCategory | null>(null);
  const [formData, setFormData] = useState<FormData>(initialFormData);

  const canEdit = userRole?.role === "owner" || userRole?.role === "admin";

  const handleOpenDialog = (category?: EtimsTaxCategory) => {
    if (category) {
      setEditingCategory(category);
      setFormData({
        code: category.code,
        name: category.name,
        rate: category.rate,
        description: category.description || "",
        is_active: category.is_active,
        sort_order: category.sort_order,
      });
    } else {
      setEditingCategory(null);
      setFormData({
        ...initialFormData,
        sort_order: categories.length + 1,
      });
    }
    setShowDialog(true);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (editingCategory) {
      updateCategory({
        id: editingCategory.id,
        ...formData,
      });
    } else {
      createCategory(formData);
    }
    setShowDialog(false);
    setEditingCategory(null);
    setFormData(initialFormData);
  };

  const handleDelete = (category: EtimsTaxCategory) => {
    setDeletingCategory(category);
    setShowDeleteDialog(true);
  };

  const confirmDelete = () => {
    if (deletingCategory) {
      deleteCategory(deletingCategory.id);
    }
    setShowDeleteDialog(false);
    setDeletingCategory(null);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-col sm:flex-row sm:items-center gap-3 sm:justify-between">
        <div className="flex items-start sm:items-center gap-2">
          <FileCheck2 className="h-5 w-5 text-muted-foreground shrink-0 mt-0.5 sm:mt-0" />
          <div>
            <CardTitle className="text-base sm:text-lg">eTIMS Tax Categories</CardTitle>
            <CardDescription>
              Configure KRA eTIMS tax type codes (A, B, C, D, E, etc.) for fiscal compliance
            </CardDescription>
          </div>
        </div>
        {canEdit && (
          <div className="flex gap-2 w-full sm:w-auto">
            {categories.length === 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => initializeDefaults()}
                className="flex-1 sm:flex-none"
              >
                <RefreshCw className="mr-2 h-4 w-4" />
                Load KRA Defaults
              </Button>
            )}
            <Button size="sm" onClick={() => handleOpenDialog()} className="flex-1 sm:flex-none">
              <Plus className="mr-2 h-4 w-4" />
              Add Category
            </Button>
          </div>
        )}
      </CardHeader>
      <CardContent>
        {categories.length === 0 ? (
          <div className="text-center py-8">
            <p className="text-muted-foreground mb-4">
              No eTIMS tax categories configured. Click "Load KRA Defaults" to add the standard categories.
            </p>
          </div>
        ) : (
          <>
          {/* Mobile card view */}
          <div className="sm:hidden space-y-3">
            {categories.map((category) => (
              <div key={category.id} className="border rounded-lg p-3 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 space-y-0.5">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="font-mono text-sm shrink-0">{category.code}</Badge>
                      <span className="font-medium truncate">{category.name}</span>
                    </div>
                    {category.description && (
                      <p className="text-xs text-muted-foreground line-clamp-2">{category.description}</p>
                    )}
                  </div>
                  <Badge variant={category.is_active ? "default" : "secondary"} className="shrink-0">
                    {category.is_active ? "Active" : "Inactive"}
                  </Badge>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Rate: {category.rate}%</span>
                  {canEdit && (
                    <div className="flex gap-1">
                      <Button variant="ghost" size="sm" className="h-8" onClick={() => handleOpenDialog(category)}>
                        <Pencil className="h-3.5 w-3.5 mr-1" /> Edit
                      </Button>
                      <Button variant="ghost" size="sm" className="h-8 text-destructive" onClick={() => handleDelete(category)}>
                        <Trash2 className="h-3.5 w-3.5 mr-1" /> Delete
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
          {/* Desktop table view */}
          <div className="hidden sm:block overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-20">Code</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead className="w-24">Rate</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead className="w-24">Status</TableHead>
                  {canEdit && <TableHead className="w-24"></TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {categories.map((category) => (
                  <TableRow key={category.id}>
                    <TableCell>
                      <Badge variant="outline" className="font-mono text-base">
                        {category.code}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-medium">{category.name}</TableCell>
                    <TableCell>{category.rate}%</TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {category.description || "—"}
                    </TableCell>
                    <TableCell>
                      <Badge variant={category.is_active ? "default" : "secondary"}>
                        {category.is_active ? "Active" : "Inactive"}
                      </Badge>
                    </TableCell>
                    {canEdit && (
                      <TableCell>
                        <div className="flex gap-1">
                          <Button variant="ghost" size="icon" onClick={() => handleOpenDialog(category)}>
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button variant="ghost" size="icon" onClick={() => handleDelete(category)}>
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          </>
        )}

        <div className="mt-4 p-4 bg-muted/50 rounded-lg">
          <p className="text-sm text-muted-foreground">
            <strong>Note:</strong> These tax categories are used for KRA eTIMS compliance. 
            If the government introduces new tax codes or modifies existing ones, you can 
            update them here. The code (e.g., "A", "B") is transmitted to KRA in fiscal documents.
          </p>
        </div>
      </CardContent>

      {/* Add/Edit Dialog */}
      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editingCategory ? "Edit Tax Category" : "Add Tax Category"}
            </DialogTitle>
            <DialogDescription>
              Configure an eTIMS tax type code for KRA fiscal compliance
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="code">Code *</Label>
                <Input
                  id="code"
                  value={formData.code}
                  onChange={(e) =>
                    setFormData({ ...formData, code: e.target.value.toUpperCase() })
                  }
                  placeholder="e.g., A, B, F"
                  maxLength={5}
                  required
                />
                <p className="text-xs text-muted-foreground">
                  The code transmitted to KRA
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="rate">Rate (%) *</Label>
                <Input
                  id="rate"
                  type="number"
                  step="0.01"
                  min="0"
                  max="100"
                  value={formData.rate}
                  onChange={(e) =>
                    setFormData({ ...formData, rate: parseFloat(e.target.value) || 0 })
                  }
                  required
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="name">Name *</Label>
              <Input
                id="name"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="e.g., VAT 16%, Zero-Rated"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                value={formData.description}
                onChange={(e) =>
                  setFormData({ ...formData, description: e.target.value })
                }
                placeholder="Describe when this tax category applies"
                rows={2}
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="sort_order">Sort Order</Label>
                <Input
                  id="sort_order"
                  type="number"
                  min="0"
                  value={formData.sort_order}
                  onChange={(e) =>
                    setFormData({ ...formData, sort_order: parseInt(e.target.value) || 0 })
                  }
                />
              </div>
              <div className="flex items-center justify-between pt-6">
                <Label>Active</Label>
                <Switch
                  checked={formData.is_active}
                  onCheckedChange={(checked) =>
                    setFormData({ ...formData, is_active: checked })
                  }
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => setShowDialog(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isCreating || isUpdating}>
                {(isCreating || isUpdating) && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                {editingCategory ? "Update" : "Create"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Tax Category?</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete the tax category "{deletingCategory?.code} - {deletingCategory?.name}"? 
              This may affect products and invoices using this category.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete} className="bg-destructive text-destructive-foreground">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
