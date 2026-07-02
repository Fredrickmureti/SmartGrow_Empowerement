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

interface ConfirmDeleteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
  description?: string;
  itemName?: string;
  onConfirm: () => void;
  isLoading?: boolean;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "destructive" | "warning";
}

export function ConfirmDeleteDialog({
  open,
  onOpenChange,
  title = "Confirm Delete",
  description,
  itemName,
  onConfirm,
  isLoading = false,
  confirmLabel = "Delete",
  cancelLabel = "Cancel",
  variant = "destructive",
}: ConfirmDeleteDialogProps) {
  const defaultDescription = itemName
    ? `Are you sure you want to delete "${itemName}"? This action cannot be undone.`
    : "Are you sure you want to delete this item? This action cannot be undone.";

  const handleConfirm = () => {
    onConfirm();
    onOpenChange(false);
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-[95vw] sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>
            {description || defaultDescription}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="flex-col sm:flex-row gap-2">
          <AlertDialogCancel disabled={isLoading}>
            {cancelLabel}
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={handleConfirm}
            disabled={isLoading}
            className={
              variant === "destructive"
                ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                : "bg-yellow-600 text-white hover:bg-yellow-700"
            }
          >
            {isLoading ? "Deleting..." : confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// Hook to manage delete confirmation state
import { useState, useCallback } from "react";

interface UseConfirmDeleteOptions<T> {
  onConfirm: (item: T) => Promise<void> | void;
}

export function useConfirmDelete<T>({ onConfirm }: UseConfirmDeleteOptions<T>) {
  const [isOpen, setIsOpen] = useState(false);
  const [itemToDelete, setItemToDelete] = useState<T | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const requestDelete = useCallback((item: T) => {
    setItemToDelete(item);
    setIsOpen(true);
  }, []);

  const confirmDelete = useCallback(async () => {
    if (!itemToDelete) return;
    
    setIsDeleting(true);
    try {
      await onConfirm(itemToDelete);
    } finally {
      setIsDeleting(false);
      setItemToDelete(null);
      setIsOpen(false);
    }
  }, [itemToDelete, onConfirm]);

  const cancelDelete = useCallback(() => {
    setIsOpen(false);
    setItemToDelete(null);
  }, []);

  return {
    isOpen,
    setIsOpen,
    itemToDelete,
    isDeleting,
    requestDelete,
    confirmDelete,
    cancelDelete,
  };
}
