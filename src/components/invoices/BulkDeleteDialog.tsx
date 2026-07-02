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
import { AlertTriangle, Trash2, Loader2, CheckCircle, Shield } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Invoice } from "@/hooks/useInvoices";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useSession } from "@/contexts/SessionContext";

interface BulkDeleteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedInvoices: Invoice[];
  onConfirm: () => Promise<void>;
}

export function BulkDeleteDialog({
  open,
  onOpenChange,
  selectedInvoices,
  onConfirm,
}: BulkDeleteDialogProps) {
  const [step, setStep] = useState(1);
  const [confirmText, setConfirmText] = useState("");
  const [isDeleting, setIsDeleting] = useState(false);
  const { userRole } = useSession();

  // Admins can delete all invoices, others can only delete draft/sent/overdue
  const isAdmin = userRole === "admin" || userRole === "owner" || userRole === "super_admin";
  const deletableStatuses = isAdmin 
    ? ["draft", "sent", "overdue", "paid", "partial"] 
    : ["draft", "sent", "overdue"];
  
  const deletableInvoices = selectedInvoices.filter((inv) => deletableStatuses.includes(inv.status));
  const nonDeletableInvoices = selectedInvoices.filter((inv) => !deletableStatuses.includes(inv.status));
  
  const expectedConfirmText = `DELETE ${deletableInvoices.length} INVOICES`;

  const handleClose = () => {
    setStep(1);
    setConfirmText("");
    setIsDeleting(false);
    onOpenChange(false);
  };

  const handleNext = () => {
    if (step < 3) {
      setStep(step + 1);
    }
  };

  const handleBack = () => {
    if (step > 1) {
      setStep(step - 1);
    }
  };

  const handleConfirmDelete = async () => {
    setIsDeleting(true);
    try {
      await onConfirm();
      handleClose();
    } catch (error) {
      setIsDeleting(false);
    }
  };

  const canProceed = () => {
    if (step === 1) return deletableInvoices.length > 0;
    if (step === 2) return confirmText === expectedConfirmText;
    return true;
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-destructive">
            <Trash2 className="h-5 w-5" />
            Delete {deletableInvoices.length} Invoice{deletableInvoices.length !== 1 ? "s" : ""}
          </DialogTitle>
          <DialogDescription>
            Step {step} of 3 - This action cannot be undone
          </DialogDescription>
        </DialogHeader>

        {/* Progress indicator */}
        <div className="flex gap-2 mb-4">
          {[1, 2, 3].map((s) => (
            <div
              key={s}
              className={`h-2 flex-1 rounded-full transition-colors ${
                s <= step ? "bg-destructive" : "bg-muted"
              }`}
            />
          ))}
        </div>

        {/* Step 1: Warning */}
        {step === 1 && (
          <div className="space-y-4">
            {isAdmin && deletableInvoices.some(inv => inv.status === "paid" || inv.status === "partial") && (
              <Alert className="border-amber-500/50 bg-amber-500/10">
                <Shield className="h-4 w-4 text-amber-500" />
                <AlertTitle className="text-amber-600">Admin Override Active</AlertTitle>
                <AlertDescription className="text-amber-600/80">
                  As an admin, you can delete invoices with payments. This will affect financial records and audit trails.
                </AlertDescription>
              </Alert>
            )}

            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Warning: Permanent Deletion</AlertTitle>
              <AlertDescription>
                You are about to permanently delete {deletableInvoices.length} invoice
                {deletableInvoices.length !== 1 ? "s" : ""}. This action cannot be undone.
              </AlertDescription>
            </Alert>

            {!isAdmin && nonDeletableInvoices.length > 0 && (
              <Alert>
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>Some invoices cannot be deleted</AlertTitle>
                <AlertDescription>
                  {nonDeletableInvoices.length} selected invoice
                  {nonDeletableInvoices.length !== 1 ? "s have" : " has"} payments recorded
                  (paid/partial status) and will be skipped. Only admins can delete paid invoices.
                </AlertDescription>
              </Alert>
            )}

            {deletableInvoices.length === 0 && (
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>No deletable invoices</AlertTitle>
                <AlertDescription>
                  {isAdmin 
                    ? "No invoices selected for deletion."
                    : "All selected invoices have payments recorded. Only admins can delete paid invoices."}
                </AlertDescription>
              </Alert>
            )}
          </div>
        )}

        {/* Step 2: Type confirmation */}
        {step === 2 && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              To confirm deletion, type the following text exactly:
            </p>
            <div className="p-3 bg-muted rounded-md font-mono text-sm font-bold">
              {expectedConfirmText}
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirm">Type to confirm</Label>
              <Input
                id="confirm"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder="Type the text above"
                className={
                  confirmText === expectedConfirmText
                    ? "border-green-500 focus-visible:ring-green-500"
                    : ""
                }
              />
              {confirmText === expectedConfirmText && (
                <p className="text-sm text-green-600 flex items-center gap-1">
                  <CheckCircle className="h-4 w-4" /> Confirmation text matches
                </p>
              )}
            </div>
          </div>
        )}

        {/* Step 3: Final review */}
        {step === 3 && (
          <div className="space-y-4">
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Final Confirmation</AlertTitle>
              <AlertDescription>
                This is your last chance to cancel. The following invoices will be
                permanently deleted:
              </AlertDescription>
            </Alert>

            <ScrollArea className="h-48 rounded-md border p-4">
              <div className="space-y-2">
                {deletableInvoices.map((invoice) => (
                  <div
                    key={invoice.id}
                    className="flex justify-between items-center py-2 border-b last:border-0"
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{invoice.invoice_number}</span>
                      <span className="text-xs px-1.5 py-0.5 rounded bg-muted capitalize">
                        {invoice.status}
                      </span>
                    </div>
                    <span className="text-sm text-muted-foreground">
                      {invoice.contact?.name || "No customer"}
                    </span>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </div>
        )}

        <DialogFooter className="flex gap-2 sm:gap-0">
          {step > 1 && (
            <Button variant="outline" onClick={handleBack} disabled={isDeleting}>
              Back
            </Button>
          )}
          <Button variant="outline" onClick={handleClose} disabled={isDeleting}>
            Cancel
          </Button>
          {step < 3 ? (
            <Button
              variant="destructive"
              onClick={handleNext}
              disabled={!canProceed()}
            >
              Continue
            </Button>
          ) : (
            <Button
              variant="destructive"
              onClick={handleConfirmDelete}
              disabled={isDeleting}
            >
              {isDeleting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Delete {deletableInvoices.length} Invoice{deletableInvoices.length !== 1 ? "s" : ""}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
