import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { usePOSRegisters } from "@/hooks/pos/usePOSRegisters";
import { useBranches } from "@/hooks/useBranches";
import { toast } from "sonner";

// SCOPE-TRIGGER-EXEMPT: form selector for branch when creating a POS register, not a scope switcher
interface CreateRegisterDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateRegisterDialog({ open, onOpenChange }: CreateRegisterDialogProps) {
  const { createRegister } = usePOSRegisters();
  const { branches } = useBranches();
  
  const [formData, setFormData] = useState({
    register_name: "",
    register_code: "",
    branch_id: "",
    receipt_header: "",
    receipt_footer: "",
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.branch_id) {
      toast.error("Select a branch before creating a register");
      return;
    }
    
    await createRegister.mutateAsync({
      register_name: formData.register_name,
      register_code: formData.register_code.toUpperCase(),
      branch_id: formData.branch_id,
      receipt_header: formData.receipt_header || undefined,
      receipt_footer: formData.receipt_footer || undefined,
    });
    
    setFormData({
      register_name: "",
      register_code: "",
      branch_id: "",
      receipt_header: "",
      receipt_footer: "",
    });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create New Register</DialogTitle>
        </DialogHeader>
        
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="register_name">Register Name *</Label>
            <Input
              id="register_name"
              value={formData.register_name}
              onChange={(e) => setFormData({ ...formData, register_name: e.target.value })}
              placeholder="e.g., Main Counter, Terminal 1"
              required
            />
          </div>
          
          <div className="space-y-2">
            <Label htmlFor="register_code">Register Code *</Label>
            <Input
              id="register_code"
              value={formData.register_code}
              onChange={(e) => setFormData({ ...formData, register_code: e.target.value.toUpperCase() })}
              placeholder="e.g., REG01, POS1"
              required
              maxLength={10}
            />
            <p className="text-xs text-muted-foreground">
              Used for transaction numbering. Keep it short.
            </p>
          </div>
          
          {branches && branches.length > 0 && (
            <div className="space-y-2">
              <Label htmlFor="branch_id">Branch *</Label>
              <Select
                value={formData.branch_id}
                onValueChange={(value) => setFormData({ ...formData, branch_id: value })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select a branch" />
                </SelectTrigger>
                <SelectContent>
                  {branches.map((branch) => (
                    <SelectItem key={branch.id} value={branch.id}>
                      {branch.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {(!branches || branches.length === 0) && (
            <p className="text-sm text-destructive">Create a branch before adding POS registers.</p>
          )}
          
          <div className="space-y-2">
            <Label htmlFor="receipt_header">Receipt Header (Optional)</Label>
            <Input
              id="receipt_header"
              value={formData.receipt_header}
              onChange={(e) => setFormData({ ...formData, receipt_header: e.target.value })}
              placeholder="Text shown at top of receipt"
            />
          </div>
          
          <div className="space-y-2">
            <Label htmlFor="receipt_footer">Receipt Footer (Optional)</Label>
            <Input
              id="receipt_footer"
              value={formData.receipt_footer}
              onChange={(e) => setFormData({ ...formData, receipt_footer: e.target.value })}
              placeholder="e.g., Thank you for shopping!"
            />
          </div>
          
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={createRegister.isPending || !formData.branch_id}>
              {createRegister.isPending ? "Creating..." : "Create Register"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
