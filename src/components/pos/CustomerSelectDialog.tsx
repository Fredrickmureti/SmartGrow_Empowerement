import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Search, UserPlus, User, ArrowLeft, Loader2 } from "lucide-react";
import { usePOSCustomers } from "@/hooks/pos/usePOSCustomers";

interface CustomerSelectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (customer: { id: string; name: string; email?: string; phone?: string } | null) => void;
}

export function CustomerSelectDialog({ open, onOpenChange, onSelect }: CustomerSelectDialogProps) {
  const { customers, isLoading, createCustomer } = usePOSCustomers();
  const [search, setSearch] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  
  // New customer form state
  const [newName, setNewName] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [formError, setFormError] = useState("");

  const filteredCustomers = customers.filter(
    (c) =>
      c.name.toLowerCase().includes(search.toLowerCase()) ||
      c.email?.toLowerCase().includes(search.toLowerCase()) ||
      c.phone?.toLowerCase().includes(search.toLowerCase())
  );

  const resetForm = () => {
    setNewName("");
    setNewPhone("");
    setNewEmail("");
    setFormError("");
    setIsCreating(false);
  };

  const handleClose = (open: boolean) => {
    if (!open) {
      resetForm();
      setSearch("");
    }
    onOpenChange(open);
  };

  const handleCreateCustomer = async () => {
    // Validate
    if (!newName.trim()) {
      setFormError("Customer name is required");
      return;
    }

    if (newName.trim().length < 2) {
      setFormError("Name must be at least 2 characters");
      return;
    }

    if (newEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
      setFormError("Please enter a valid email address");
      return;
    }

    if (newPhone && !/^[\d\s\+\-()]{7,20}$/.test(newPhone)) {
      setFormError("Please enter a valid phone number");
      return;
    }

    setFormError("");

    try {
      const result = await createCustomer.mutateAsync({
        name: newName.trim(),
        phone: newPhone.trim() || undefined,
        email: newEmail.trim() || undefined,
      });

      // Immediately select the new customer
      onSelect({
        id: result.id,
        name: result.name,
        email: result.email,
        phone: result.phone,
      });

      resetForm();
    } catch (error) {
      // Error is handled by the mutation
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-[95vw] sm:max-w-md max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="text-base sm:text-lg flex items-center gap-2">
            {isCreating && (
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 -ml-1"
                onClick={() => setIsCreating(false)}
              >
                <ArrowLeft className="h-4 w-4" />
              </Button>
            )}
            {isCreating ? "New Customer" : "Select Customer"}
          </DialogTitle>
        </DialogHeader>
        
        {isCreating ? (
          // Create customer form
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="customer-name">
                Name <span className="text-destructive">*</span>
              </Label>
              <Input
                id="customer-name"
                placeholder="Customer name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                className="h-11"
                autoFocus
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="customer-phone">
                Phone <span className="text-muted-foreground text-xs">(for loyalty & receipts)</span>
              </Label>
              <Input
                id="customer-phone"
                type="tel"
                placeholder="+254 7XX XXX XXX"
                value={newPhone}
                onChange={(e) => setNewPhone(e.target.value)}
                className="h-11"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="customer-email">
                Email <span className="text-muted-foreground text-xs">(optional)</span>
              </Label>
              <Input
                id="customer-email"
                type="email"
                placeholder="customer@example.com"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                className="h-11"
              />
            </div>

            {formError && (
              <p className="text-sm text-destructive">{formError}</p>
            )}

            <div className="flex gap-2 pt-2">
              <Button
                variant="outline"
                className="flex-1 h-11"
                onClick={() => setIsCreating(false)}
              >
                Cancel
              </Button>
              <Button
                className="flex-1 h-11"
                onClick={handleCreateCustomer}
                disabled={createCustomer.isPending}
              >
                {createCustomer.isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Creating...
                  </>
                ) : (
                  <>
                    <UserPlus className="h-4 w-4 mr-2" />
                    Create & Add
                  </>
                )}
              </Button>
            </div>
          </div>
        ) : (
          // Customer selection view
          <div className="space-y-3 sm:space-y-4 flex-1 flex flex-col min-h-0">
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search customers..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-10 h-10 sm:h-9 text-base sm:text-sm"
                />
              </div>
              <Button
                variant="default"
                size="icon"
                className="h-10 w-10 sm:h-9 sm:w-9 shrink-0"
                onClick={() => setIsCreating(true)}
                title="Add new customer"
              >
                <UserPlus className="h-4 w-4" />
              </Button>
            </div>

            <Button
              variant="outline"
              className="w-full justify-start h-12 sm:h-10 text-sm"
              onClick={() => onSelect(null)}
            >
              <User className="h-4 w-4 mr-2 shrink-0" />
              <span className="truncate">Walk-in Customer (No customer)</span>
            </Button>

            <ScrollArea className="flex-1 min-h-0 h-48 sm:h-64">
              <div className="space-y-1 pr-2">
                {isLoading ? (
                  Array.from({ length: 5 }).map((_, i) => (
                    <div key={i} className="h-12 sm:h-14 bg-muted animate-pulse rounded" />
                  ))
                ) : filteredCustomers.length === 0 ? (
                  <div className="text-center py-6 sm:py-8 text-muted-foreground">
                    <p className="text-sm">{search ? "No customers found" : "No customers yet"}</p>
                    <Button
                      variant="link"
                      className="mt-2 text-primary"
                      onClick={() => setIsCreating(true)}
                    >
                      <UserPlus className="h-4 w-4 mr-1" />
                      Add your first customer
                    </Button>
                  </div>
                ) : (
                  filteredCustomers.map((customer) => (
                    <Button
                      key={customer.id}
                      variant="ghost"
                      className="w-full justify-start h-auto py-2.5 sm:py-3 px-2"
                      onClick={() => onSelect({
                        id: customer.id,
                        name: customer.name,
                        email: customer.email || undefined,
                        phone: customer.phone || undefined,
                      })}
                    >
                      <div className="flex items-center gap-2 sm:gap-3 min-w-0">
                        <div className="h-8 w-8 sm:h-10 sm:w-10 rounded-full bg-muted flex items-center justify-center shrink-0">
                          <User className="h-4 w-4 sm:h-5 sm:w-5 text-muted-foreground" />
                        </div>
                        <div className="text-left min-w-0">
                          <p className="font-medium text-sm truncate">{customer.name}</p>
                          <p className="text-xs text-muted-foreground truncate">
                            {customer.phone || customer.email || "No contact info"}
                          </p>
                        </div>
                      </div>
                    </Button>
                  ))
                )}
              </div>
            </ScrollArea>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
