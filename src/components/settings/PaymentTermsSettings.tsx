// @ts-nocheck
import { useState } from "react";
import { ConfirmDeleteDialog, useConfirmDelete } from "@/components/shared/ConfirmDeleteDialog";
import { usePaymentTerms, PaymentTerm } from "@/hooks/usePaymentTerms";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import {
  Plus,
  Loader2,
  Calendar,
  MoreHorizontal,
  Pencil,
  Trash2,
  Star,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { normalizeError } from "@/services/resilience";

export function PaymentTermsSettings() {
  const { paymentTerms, isLoading, createPaymentTerm, updatePaymentTerm, deletePaymentTerm } = usePaymentTerms();
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [showDialog, setShowDialog] = useState(false);
  const [editingTerm, setEditingTerm] = useState<PaymentTerm | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [formData, setFormData] = useState({
    name: "",
    days: 30,
    description: "",
    is_active: true,
  });

  const resetForm = () => {
    setFormData({
      name: "",
      days: 30,
      description: "",
      is_active: true,
    });
    setEditingTerm(null);
  };

  const handleOpenDialog = (term?: PaymentTerm) => {
    if (term) {
      setEditingTerm(term);
      setFormData({
        name: term.name,
        days: term.days,
        description: term.description || "",
        is_active: term.is_active,
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
      if (editingTerm) {
        await updatePaymentTerm.mutateAsync({ id: editingTerm.id, ...formData });
        toast({ title: "Payment term updated successfully" });
      } else {
        await createPaymentTerm.mutateAsync(formData);
        toast({ title: "Payment term created successfully" });
      }
      setShowDialog(false);
      resetForm();
    } catch (error: any) {
      toast({ title: "Error", description: normalizeError(error).message, variant: "destructive" });
    } finally {
      setIsSubmitting(false);
    }
  };

  const executeDeletePaymentTerm = async (term: PaymentTerm) => {
    try {
      await deletePaymentTerm.mutateAsync(term.id);
      toast({ title: "Payment term deleted" });
    } catch (error: any) {
      toast({ title: "Error", description: normalizeError(error).message, variant: "destructive" });
    }
  };

  const deleteConfirm = useConfirmDelete<PaymentTerm>({ onConfirm: executeDeletePaymentTerm });

  const handleDelete = (term: PaymentTerm) => {
    deleteConfirm.requestDelete(term);
  };

  const handleSetDefault = async (term: PaymentTerm) => {
    if (!currentOrg) return;
    if (!currentBusiness?.id) {
      toast({
        title: "Select a Company",
        description: "Payment term defaults are scoped per Company. Pick a Company first.",
        variant: "destructive",
      });
      return;
    }

    try {
      // Unset existing default ONLY within this Company
      await supabase
        .from("payment_terms")
        .update({ is_default: false })
        .eq("business_id", currentBusiness.id);

      // Then set the new default (already in this Company by virtue of the term row)
      await supabase
        .from("payment_terms")
        .update({ is_default: true })
        .eq("id", term.id);

      queryClient.invalidateQueries({ queryKey: ["payment-terms"] });
      toast({ title: `"${term.name}" is now the default payment term for this Company` });
    } catch (error: any) {
      toast({ title: "Error", description: normalizeError(error).message, variant: "destructive" });
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle>Payment Terms</CardTitle>
          <CardDescription>
            Define payment terms for invoices and bills
          </CardDescription>
        </div>
        <Button onClick={() => handleOpenDialog()}>
          <Plus className="mr-2 h-4 w-4" />
          Add Term
        </Button>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : paymentTerms.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <Calendar className="h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-medium">No payment terms</h3>
            <p className="text-muted-foreground">Add payment terms like "Net 30", "Due on Receipt", etc.</p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Days</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-12"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {paymentTerms.map((term) => (
                <TableRow key={term.id}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{term.name}</span>
                      {term.is_default && (
                        <Badge variant="secondary" className="bg-amber-100 text-amber-800">
                          <Star className="h-3 w-3 mr-1" />
                          Default
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>{term.days} days</TableCell>
                  <TableCell className="text-muted-foreground truncate max-w-xs">
                    {term.description || "-"}
                  </TableCell>
                  <TableCell>
                    {term.is_active ? (
                      <Badge className="bg-green-100 text-green-800">Active</Badge>
                    ) : (
                      <Badge variant="secondary">Inactive</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon">
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {!term.is_default && (
                          <DropdownMenuItem onClick={() => handleSetDefault(term)}>
                            <Star className="mr-2 h-4 w-4" />
                            Set as Default
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuItem onClick={() => handleOpenDialog(term)}>
                          <Pencil className="mr-2 h-4 w-4" />
                          Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => handleDelete(term)} className="text-destructive">
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
        )}
      </CardContent>

      {/* Add/Edit Dialog */}
      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingTerm ? "Edit Payment Term" : "Add Payment Term"}</DialogTitle>
            <DialogDescription>
              {editingTerm ? "Update payment term details." : "Create a new payment term."}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">Name *</Label>
              <Input
                id="name"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="e.g., Net 30"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="days">Due in Days *</Label>
              <Input
                id="days"
                type="number"
                min="0"
                value={formData.days}
                onChange={(e) => setFormData({ ...formData, days: parseInt(e.target.value) || 0 })}
                required
              />
              <p className="text-xs text-muted-foreground">
                Number of days until payment is due. Use 0 for "Due on Receipt".
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                placeholder="Payment is due within 30 days of invoice date"
                rows={2}
              />
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="is_active">Active</Label>
              <Switch
                id="is_active"
                checked={formData.is_active}
                onCheckedChange={(checked) => setFormData({ ...formData, is_active: checked })}
              />
            </div>
            <div className="flex justify-end gap-3">
              <Button type="button" variant="outline" onClick={() => setShowDialog(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {editingTerm ? "Update" : "Create"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <ConfirmDeleteDialog
        open={deleteConfirm.isOpen}
        onOpenChange={deleteConfirm.setIsOpen}
        title="Delete Payment Term"
        itemName={deleteConfirm.itemToDelete?.name}
        onConfirm={deleteConfirm.confirmDelete}
        isLoading={deleteConfirm.isDeleting}
      />
    </Card>
  );
}
