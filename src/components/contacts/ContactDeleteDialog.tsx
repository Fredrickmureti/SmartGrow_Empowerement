import { useState } from "react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, Archive, Trash2, AlertTriangle, FileText } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

export interface ContactDependency {
  table: string;
  label: string;
  count: number;
}

interface ContactDeleteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contactName: string;
  contactId: string;
  onDelete: () => Promise<void>;
  onArchive: () => Promise<void>;
}

export function ContactDeleteDialog({
  open,
  onOpenChange,
  contactName,
  contactId,
  onDelete,
  onArchive,
}: ContactDeleteDialogProps) {
  const [isChecking, setIsChecking] = useState(false);
  const [isActing, setIsActing] = useState(false);
  const [dependencies, setDependencies] = useState<ContactDependency[] | null>(null);
  const [canDelete, setCanDelete] = useState<boolean | null>(null);

  const checkDependencies = async () => {
    setIsChecking(true);
    try {
      const { data, error } = await supabase.rpc("check_contact_dependencies", {
        p_contact_id: contactId,
      });
      if (error) throw error;
      const result = data as unknown as { can_delete: boolean; dependencies: ContactDependency[] };
      setCanDelete(result.can_delete);
      setDependencies(result.dependencies);
    } catch {
      // If RPC fails, allow delete attempt (fallback to old behavior)
      setCanDelete(true);
      setDependencies([]);
    } finally {
      setIsChecking(false);
    }
  };

  const handleOpenChange = (value: boolean) => {
    if (!value) {
      // Reset state on close
      setDependencies(null);
      setCanDelete(null);
      setIsActing(false);
    }
    onOpenChange(value);
  };

  const handleDelete = async () => {
    setIsActing(true);
    try {
      await onDelete();
      handleOpenChange(false);
    } finally {
      setIsActing(false);
    }
  };

  const handleArchive = async () => {
    setIsActing(true);
    try {
      await onArchive();
      handleOpenChange(false);
    } finally {
      setIsActing(false);
    }
  };

  // On open, trigger dependency check
  if (open && dependencies === null && !isChecking) {
    checkDependencies();
  }

  const totalDeps = dependencies?.reduce((sum, d) => sum + d.count, 0) ?? 0;

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogContent className="max-w-[95vw] sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            {canDelete === false && <AlertTriangle className="h-5 w-5 text-yellow-500" />}
            {canDelete === false ? "Cannot Delete Contact" : "Delete Contact"}
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3">
              {isChecking ? (
                <div className="flex items-center gap-2 py-4">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>Checking for linked records…</span>
                </div>
              ) : canDelete === false ? (
                <>
                  <p>
                    <strong>{contactName}</strong> is linked to{" "}
                    <strong>{totalDeps} record{totalDeps > 1 ? "s" : ""}</strong> and cannot be
                    deleted. You can <strong>archive</strong> this contact instead — it will be
                    hidden from lists but preserved for reporting.
                  </p>
                  <div className="rounded-md border bg-muted/50 p-3 space-y-1.5">
                    {dependencies?.map((dep) => (
                      <div key={dep.table} className="flex items-center justify-between text-sm">
                        <span className="flex items-center gap-1.5">
                          <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                          {dep.label}
                        </span>
                        <Badge variant="secondary" className="text-xs">
                          {dep.count}
                        </Badge>
                      </div>
                    ))}
                  </div>
                </>
              ) : canDelete === true ? (
                <p>
                  Are you sure you want to permanently delete <strong>{contactName}</strong>? This
                  action cannot be undone.
                </p>
              ) : null}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>

        {!isChecking && canDelete !== null && (
          <AlertDialogFooter className="flex-col sm:flex-row gap-2">
            <AlertDialogCancel disabled={isActing}>Cancel</AlertDialogCancel>
            {canDelete === false ? (
              <Button onClick={handleArchive} disabled={isActing} className="gap-1.5">
                {isActing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Archive className="h-4 w-4" />
                )}
                Archive Contact
              </Button>
            ) : (
              <Button
                variant="destructive"
                onClick={handleDelete}
                disabled={isActing}
                className="gap-1.5"
              >
                {isActing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Trash2 className="h-4 w-4" />
                )}
                Delete
              </Button>
            )}
          </AlertDialogFooter>
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}
