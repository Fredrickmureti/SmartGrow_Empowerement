import { normalizeError } from "@/services/resilience";
/**
 * Phase 4b: Bulk Update Actions
 * Multi-select contacts → bulk update payment terms, customer group, active status.
 */
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { usePaymentTerms } from "@/hooks/usePaymentTerms";
import { useCustomerGroups } from "@/hooks/useCustomerGroups";
import { Loader2, Settings2 } from "lucide-react";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedIds: string[];
  onUpdated: () => void;
}

export function ContactBulkActions({ open, onOpenChange, selectedIds, onUpdated }: Props) {
  const [field, setField] = useState<string>("");
  const [value, setValue] = useState<string>("");
  const [isUpdating, setIsUpdating] = useState(false);
  const { toast } = useToast();
  const { paymentTerms } = usePaymentTerms();
  const { activeGroups } = useCustomerGroups();

  const handleBulkUpdate = async () => {
    if (!field || !value || selectedIds.length === 0) return;

    setIsUpdating(true);
    try {
      let updateData: Record<string, any> = {};
      
      switch (field) {
        case "payment_term_id":
          updateData.payment_term_id = value === "none" ? null : value;
          break;
        case "customer_group_id":
          updateData.customer_group_id = value === "none" ? null : value;
          break;
        case "is_active":
          updateData.is_active = value === "true";
          break;
        case "credit_hold":
          updateData.credit_hold = value === "true";
          break;
      }

      const { error } = await supabase
        .from("contacts")
        .update(updateData as any)
        .in("id", selectedIds);

      if (error) throw error;

      toast({
        title: "Bulk update complete",
        description: `Updated ${selectedIds.length} contact(s)`,
      });

      onOpenChange(false);
      onUpdated();
    } catch (error: any) {
      toast({
        title: "Bulk update failed",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    } finally {
      setIsUpdating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Settings2 className="h-5 w-5" /> Bulk Update ({selectedIds.length} contacts)
          </DialogTitle>
          <DialogDescription>
            Choose a field and value to apply to all selected contacts.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Field to update</Label>
            <Select value={field} onValueChange={(v) => { setField(v); setValue(""); }}>
              <SelectTrigger>
                <SelectValue placeholder="Select field..." />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="payment_term_id">Payment Terms</SelectItem>
                <SelectItem value="customer_group_id">Customer Group</SelectItem>
                <SelectItem value="is_active">Active Status</SelectItem>
                <SelectItem value="credit_hold">Credit Hold</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {field && (
            <div className="space-y-2">
              <Label>New value</Label>
              {field === "payment_term_id" && (
                <Select value={value} onValueChange={setValue}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select payment terms..." />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No default</SelectItem>
                    {paymentTerms.map(t => (
                      <SelectItem key={t.id} value={t.id}>{t.name} ({t.days} days)</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {field === "customer_group_id" && (
                <Select value={value} onValueChange={setValue}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select group..." />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No group</SelectItem>
                    {activeGroups.map(g => (
                      <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {field === "is_active" && (
                <Select value={value} onValueChange={setValue}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select status..." />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="true">Active</SelectItem>
                    <SelectItem value="false">Inactive / Archived</SelectItem>
                  </SelectContent>
                </Select>
              )}
              {field === "credit_hold" && (
                <Select value={value} onValueChange={setValue}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select..." />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="true">On Hold</SelectItem>
                    <SelectItem value="false">No Hold</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </div>
          )}

          <div className="flex justify-end gap-3">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isUpdating}>
              Cancel
            </Button>
            <Button onClick={handleBulkUpdate} disabled={!field || !value || isUpdating}>
              {isUpdating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Apply to {selectedIds.length} contacts
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
