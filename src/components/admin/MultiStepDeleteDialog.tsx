// @ts-nocheck - Admin tables not in auto-generated types
import { useState } from "react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, AlertTriangle, ShieldAlert, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";

interface MultiStepDeleteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entityName: string;
  entityType: string;
  onConfirm: () => Promise<void>;
  isDeleting: boolean;
}

export function MultiStepDeleteDialog({
  open,
  onOpenChange,
  entityName,
  entityType,
  onConfirm,
  isDeleting,
}: MultiStepDeleteDialogProps) {
  const [step, setStep] = useState(1);
  const [confirmText, setConfirmText] = useState("");

  const handleClose = () => {
    setStep(1);
    setConfirmText("");
    onOpenChange(false);
  };

  const handleConfirm = async () => {
    await onConfirm();
    handleClose();
  };

  const isConfirmTextValid = confirmText.toLowerCase() === entityName.toLowerCase();

  return (
    <AlertDialog open={open} onOpenChange={handleClose}>
      <AlertDialogContent className="max-w-md">
        {step === 1 && (
          <>
            <AlertDialogHeader>
              <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-900/20">
                <AlertTriangle className="h-7 w-7 text-amber-600 dark:text-amber-500" />
              </div>
              <AlertDialogTitle className="text-center">
                Delete {entityType}?
              </AlertDialogTitle>
              <AlertDialogDescription className="text-center">
                You are about to delete <strong>{entityName}</strong>. This will permanently remove all associated data including:
                <ul className="mt-3 text-left list-disc list-inside space-y-1 text-sm">
                  <li>All team members and user roles</li>
                  <li>All invoices, expenses, and financial records</li>
                  <li>All products, contacts, and documents</li>
                  <li>All settings and configurations</li>
                </ul>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter className="flex-col gap-2 sm:flex-row">
              <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
              <Button
                variant="destructive"
                onClick={() => setStep(2)}
              >
                I understand, continue
              </Button>
            </AlertDialogFooter>
          </>
        )}

        {step === 2 && (
          <>
            <AlertDialogHeader>
              <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-red-100 dark:bg-red-900/20">
                <ShieldAlert className="h-7 w-7 text-red-600 dark:text-red-500" />
              </div>
              <AlertDialogTitle className="text-center">
                Confirm Deletion
              </AlertDialogTitle>
              <AlertDialogDescription className="text-center">
                To confirm, type <strong className="text-foreground">{entityName}</strong> in the field below:
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div className="py-4">
              <Label htmlFor="confirm-name" className="sr-only">
                Type organization name
              </Label>
              <Input
                id="confirm-name"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder={`Type "${entityName}" to confirm`}
                className="text-center"
                autoComplete="off"
              />
            </div>
            <AlertDialogFooter className="flex-col gap-2 sm:flex-row">
              <Button variant="outline" onClick={() => setStep(1)} disabled={isDeleting}>
                Go Back
              </Button>
              <Button
                variant="destructive"
                onClick={() => setStep(3)}
                disabled={!isConfirmTextValid}
              >
                Confirm Deletion
              </Button>
            </AlertDialogFooter>
          </>
        )}

        {step === 3 && (
          <>
            <AlertDialogHeader>
              <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-red-500">
                <Trash2 className="h-7 w-7 text-white" />
              </div>
              <AlertDialogTitle className="text-center text-destructive">
                Final Warning
              </AlertDialogTitle>
              <AlertDialogDescription className="text-center">
                <strong className="text-destructive">This action CANNOT be undone.</strong>
                <br />
                <br />
                Once deleted, all data will be permanently lost and cannot be recovered.
                Are you absolutely sure you want to proceed?
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter className="flex-col gap-2 sm:flex-row">
              <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={handleConfirm}
                disabled={isDeleting}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                {isDeleting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Deleting...
                  </>
                ) : (
                  <>
                    <Trash2 className="mr-2 h-4 w-4" />
                    Yes, Delete Forever
                  </>
                )}
              </AlertDialogAction>
            </AlertDialogFooter>
          </>
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}
