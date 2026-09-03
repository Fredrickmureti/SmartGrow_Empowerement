import { useState, useMemo } from "react";
import { ConfirmDeleteDialog, useConfirmDelete } from "@/components/shared/ConfirmDeleteDialog";
import { useTaxRates, TaxRate } from "@/hooks/useTaxRates";
import { useBusinesses } from "@/hooks/useBusinesses";
import { usePermissions } from "@/hooks/usePermissions";
import { getTaxTerminology } from "@/lib/taxTerminology";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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
import { useToast } from "@/hooks/use-toast";
import { Loader2, Plus, Pencil, Trash2, FileCheck2 } from "lucide-react";
import { Separator } from "@/components/ui/separator";
import { normalizeError } from "@/services/resilience";

export function TaxSettings() {
  const { taxRates, isLoading, createTaxRate, updateTaxRate, deleteTaxRate } = useTaxRates();
  const { canManageTaxSettings } = usePermissions();
  const { currentBusiness } = useBusinesses();
  const taxTerms = useMemo(() => getTaxTerminology(currentBusiness?.country ?? undefined), [currentBusiness?.country]);
  const hasEtimsCodes = false;
  const { toast } = useToast();
  const [showDialog, setShowDialog] = useState(false);
  const [editingRate, setEditingRate] = useState<TaxRate | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formData, setFormData] = useState({
    name: "",
    rate: 0,
    description: "",
    is_compound: false,
    is_inclusive: false,
    is_default: false,
    etims_tax_code: null as string | null,
    tax_type: "percentage" as "percentage" | "fixed",
    fixed_amount: 0,
    effective_from: "",
    effective_to: "" as string,
  });

  const canEdit = canManageTaxSettings;

  const resetForm = () => {
    setFormData({
      name: "",
      rate: 0,
      description: "",
      is_compound: false,
      is_inclusive: false,
      is_default: false,
      etims_tax_code: null,
      tax_type: "percentage",
      fixed_amount: 0,
      effective_from: "",
      effective_to: "",
    });
    setEditingRate(null);
  };

  const handleOpenDialog = (rate?: TaxRate) => {
    if (rate) {
      setEditingRate(rate);
      setFormData({
        name: rate.name,
        rate: rate.rate,
        description: rate.description || "",
        is_compound: rate.is_compound || false,
        is_inclusive: rate.is_inclusive || false,
        is_default: rate.is_default || false,
        etims_tax_code: rate.etims_tax_code || null,
        tax_type: (rate as any).tax_type || "percentage",
        fixed_amount: (rate as any).fixed_amount || 0,
        effective_from: (rate as any).effective_from && (rate as any).effective_from !== "1900-01-01" ? (rate as any).effective_from : "",
        effective_to: (rate as any).effective_to || "",
      });
    } else {
      resetForm();
    }
    setShowDialog(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);

    try {
      const taxData = {
        name: formData.name,
        rate: formData.tax_type === "percentage" ? formData.rate : 0,
        description: formData.description || null,
        is_compound: formData.is_compound,
        is_inclusive: formData.is_inclusive,
        is_default: formData.is_default,
        is_active: true,
        etims_tax_code: formData.etims_tax_code,
        tax_type: formData.tax_type,
        fixed_amount: formData.tax_type === "fixed" ? formData.fixed_amount : 0,
        effective_from: formData.effective_from || null,
        effective_to: formData.effective_to || null,
      };

      if (editingRate) {
        await updateTaxRate(editingRate.id, taxData);
        toast({ title: "Tax rate updated" });
      } else {
        await createTaxRate(taxData);
        toast({ title: "Tax rate created" });
      }
      setShowDialog(false);
      resetForm();
    } catch (error: any) {
      toast({
        title: "Error",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const executeDeleteTaxRate = async (rate: TaxRate) => {
    try {
      await deleteTaxRate(rate.id);
      toast({ title: "Tax rate deleted" });
    } catch (error: any) {
      toast({
        title: "Error",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    }
  };

  const deleteConfirm = useConfirmDelete<TaxRate>({ onConfirm: executeDeleteTaxRate });

  const handleDelete = (rate: TaxRate) => {
    deleteConfirm.requestDelete(rate);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-col sm:flex-row sm:items-center gap-3 sm:justify-between">
          <div>
            <CardTitle>Tax Rates</CardTitle>
            <CardDescription>
              Configure tax rates for invoices and expenses
            </CardDescription>
          </div>
          {canEdit && (
            <Button size="sm" onClick={() => handleOpenDialog()} className="w-full sm:w-auto">
              <Plus className="mr-2 h-4 w-4" />
              Add Tax Rate
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {taxRates.length === 0 ? (
            <p className="text-muted-foreground text-sm py-4 text-center">
              No tax rates configured. Add your first tax rate to get started.
            </p>
          ) : (
            <>
            {/* Mobile card view */}
            <div className="sm:hidden space-y-3">
              {taxRates.map((rate) => (
                <div key={rate.id} className="border rounded-lg p-3 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-medium truncate">{rate.name}</div>
                      {rate.description && (
                        <p className="text-xs text-muted-foreground line-clamp-2">{rate.description}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {rate.is_default ? <Badge>Default</Badge> : <Badge variant="secondary">Active</Badge>}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5 text-sm">
                    <Badge variant="outline">{rate.rate}%</Badge>
                    {hasEtimsCodes && rate.etims_tax_code && (
                      <Badge variant="outline" className="font-mono text-xs">
                        eTIMS: {rate.etims_tax_code}
                      </Badge>
                    )}
                    {rate.is_inclusive && <Badge variant="outline" className="text-xs">Inclusive</Badge>}
                    {rate.is_compound && <Badge variant="outline" className="text-xs">Compound</Badge>}
                  </div>
                  {canEdit && (
                    <div className="flex gap-1 pt-1 border-t">
                      <Button variant="ghost" size="sm" className="h-8" onClick={() => handleOpenDialog(rate)}>
                        <Pencil className="h-3.5 w-3.5 mr-1" /> Edit
                      </Button>
                      <Button variant="ghost" size="sm" className="h-8 text-destructive" onClick={() => handleDelete(rate)}>
                        <Trash2 className="h-3.5 w-3.5 mr-1" /> Delete
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </div>
            {/* Desktop table view */}
            <div className="hidden sm:block overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Rate</TableHead>
                    {hasEtimsCodes && <TableHead>eTIMS Code</TableHead>}
                    <TableHead>Type</TableHead>
                    <TableHead>Status</TableHead>
                    {canEdit && <TableHead className="w-24"></TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {taxRates.map((rate) => (
                    <TableRow key={rate.id}>
                      <TableCell>
                        <div>
                          <div className="font-medium">{rate.name}</div>
                          {rate.description && (
                            <div className="text-sm text-muted-foreground">
                              {rate.description}
                            </div>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>{rate.rate}%</TableCell>
                      {hasEtimsCodes && (
                      <TableCell>
                        {rate.etims_tax_code ? (
                          <Badge variant="outline" className="font-mono">
                            {rate.etims_tax_code} - {getStandardCodeByCode(rate.etims_tax_code)?.name || "Unknown"}
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground text-sm">Not mapped</span>
                        )}
                      </TableCell>
                      )}
                      <TableCell>
                        <div className="flex gap-1 flex-wrap">
                          {rate.is_inclusive && <Badge variant="outline" className="text-xs">Inclusive</Badge>}
                          {rate.is_compound && <Badge variant="outline" className="text-xs">Compound</Badge>}
                          {!rate.is_inclusive && !rate.is_compound && (
                            <span className="text-muted-foreground">Standard</span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        {rate.is_default ? <Badge>Default</Badge> : <Badge variant="secondary">Active</Badge>}
                      </TableCell>
                      {canEdit && (
                        <TableCell>
                          <div className="flex gap-1">
                            <Button variant="ghost" size="icon" onClick={() => handleOpenDialog(rate)}>
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button variant="ghost" size="icon" onClick={() => handleDelete(rate)}>
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
        </CardContent>
      </Card>

      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editingRate ? "Edit Tax Rate" : "Add Tax Rate"}
            </DialogTitle>
            <DialogDescription>
              Configure tax rate settings{hasEtimsCodes ? " and eTIMS mapping for KRA compliance" : ""}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">Name *</Label>
              <Input
                id="name"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="e.g., VAT, GST, Sales Tax"
                required
              />
            </div>

            {/* Tax Type Selector */}
            <div className="space-y-2">
              <Label>Tax Type</Label>
              <Select
                value={formData.tax_type}
                onValueChange={(v) => setFormData({ ...formData, tax_type: v as "percentage" | "fixed" })}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="percentage">Percentage (%)</SelectItem>
                  <SelectItem value="fixed">Fixed Amount</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {formData.tax_type === "percentage" ? (
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
            ) : (
              <div className="space-y-2">
                <Label htmlFor="fixed_amount">Fixed Amount *</Label>
                <Input
                  id="fixed_amount"
                  type="number"
                  step="0.01"
                  min="0"
                  value={formData.fixed_amount}
                  onChange={(e) =>
                    setFormData({ ...formData, fixed_amount: parseFloat(e.target.value) || 0 })
                  }
                  required
                />
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Input
                id="description"
                value={formData.description}
                onChange={(e) =>
                  setFormData({ ...formData, description: e.target.value })
                }
                placeholder="Optional description"
              />
            </div>

            {/* Effective Date Range */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="effective_from">Effective From</Label>
                <Input
                  id="effective_from"
                  type="date"
                  value={formData.effective_from}
                  onChange={(e) => setFormData({ ...formData, effective_from: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="effective_to">Effective To</Label>
                <Input
                  id="effective_to"
                  type="date"
                  value={formData.effective_to}
                  onChange={(e) => setFormData({ ...formData, effective_to: e.target.value })}
                />
                <p className="text-xs text-muted-foreground">Leave blank if currently active</p>
              </div>
            </div>

            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <Label>Tax Inclusive</Label>
                  <p className="text-xs text-muted-foreground">
                    Tax is included in the item price
                  </p>
                </div>
                <Switch
                  checked={formData.is_inclusive}
                  onCheckedChange={(checked) =>
                    setFormData({ ...formData, is_inclusive: checked })
                  }
                />
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <Label>Compound Tax</Label>
                  <p className="text-xs text-muted-foreground">
                    Calculated on top of other taxes
                  </p>
                </div>
                <Switch
                  checked={formData.is_compound}
                  onCheckedChange={(checked) =>
                    setFormData({ ...formData, is_compound: checked })
                  }
                />
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <Label>Set as Default</Label>
                  <p className="text-xs text-muted-foreground">
                    Use this tax rate by default
                  </p>
                </div>
                <Switch
                  checked={formData.is_default}
                  onCheckedChange={(checked) =>
                    setFormData({ ...formData, is_default: checked })
                  }
                />
              </div>
            </div>

            {hasEtimsCodes && (
            <>
            <Separator className="my-4" />

            </>
            )}

            <div className="flex justify-end gap-2 pt-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => setShowDialog(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {editingRate ? "Update" : "Create"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <ConfirmDeleteDialog
        open={deleteConfirm.isOpen}
        onOpenChange={deleteConfirm.setIsOpen}
        title="Delete Tax Rate"
        itemName={deleteConfirm.itemToDelete?.name}
        onConfirm={deleteConfirm.confirmDelete}
        isLoading={deleteConfirm.isDeleting}
      />

      {/* eTIMS Tax Categories — removed: now reads from synced etims_standard_codes */}
    </div>
  );
}
