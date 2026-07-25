import { useState } from "react";
import { downloadCsv } from "@/lib/exports/csv";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, AlertTriangle, ShieldAlert, Trash2, Download, CheckCircle2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import type { Account } from "@/hooks/useAccounts";
import { normalizeError } from "@/services/resilience";

interface DeleteAllAccountsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accounts: Account[];
  organizationId: string;
  organizationName: string;
  onDeleted: () => void;
}

type Step = "warn" | "export" | "confirm" | "deleting";

export function DeleteAllAccountsDialog({
  open,
  onOpenChange,
  accounts,
  organizationId,
  organizationName,
  onDeleted,
}: DeleteAllAccountsDialogProps) {
  const [step, setStep] = useState<Step>("warn");
  const [confirmText, setConfirmText] = useState("");
  const [isDeleting, setIsDeleting] = useState(false);
  const [exportDone, setExportDone] = useState(false);
  const { toast } = useToast();

  const confirmPhrase = "DELETE ALL ACCOUNTS";

  const handleClose = () => {
    if (isDeleting) return;
    setStep("warn");
    setConfirmText("");
    setExportDone(false);
    onOpenChange(false);
  };

  const exportToCSV = () => {
    const headers = ["Code", "Name", "Type", "Detail Type", "Description", "Opening Balance", "Current Balance", "Status", "Parent ID"];
    const rows = accounts.map(a => [
      a.code,
      a.name,
      a.account_type,
      a.detail_type || "",
      a.description || "",
      a.opening_balance ?? 0,
      a.current_balance ?? 0,
      a.is_active ? "Active" : "Inactive",
      a.parent_id || "",
    ]);

    const csv = [headers, ...rows]
      .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(","))
      .join("\r\n");

    downloadCsv(
      `chart-of-accounts-${organizationName.replace(/\s+/g, "-").toLowerCase()}-${new Date().toISOString().split("T")[0]}.csv`,
      csv,
    );
    setExportDone(true);
    toast({ title: "Export complete", description: `${accounts.length} accounts exported to CSV.` });
  };

  const handleDelete = async () => {
    setIsDeleting(true);
    setStep("deleting");
    try {
      const { data, error } = await supabase.rpc("delete_all_chart_of_accounts", {
        p_organization_id: organizationId,
      });

      if (error) throw error;

      toast({
        title: "Chart of Accounts deleted",
        description: `${(data as any)?.deleted_count ?? accounts.length} accounts have been permanently removed.`,
      });
      onDeleted();
      handleClose();
    } catch (error: any) {
      toast({ title: "Deletion failed", description: normalizeError(error).message, variant: "destructive" });
      setStep("confirm");
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={handleClose}>
      <AlertDialogContent className="max-w-md">

        {/* Step 1: Warning */}
        {step === "warn" && (
          <>
            <AlertDialogHeader>
              <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-900/20">
                <AlertTriangle className="h-7 w-7 text-amber-600 dark:text-amber-500" />
              </div>
              <AlertDialogTitle className="text-center">Delete All Chart of Accounts?</AlertDialogTitle>
              <AlertDialogDescription className="text-center space-y-2">
                <span className="block">
                  You are about to permanently delete <strong>all {accounts.length} accounts</strong> from <strong>{organizationName}</strong>.
                </span>
                <span className="block mt-2 text-left">This will also clear:</span>
                <ul className="mt-1 text-left list-disc list-inside space-y-1 text-sm">
                  <li>All account links in bills, budgets &amp; asset categories</li>
                  <li>Default account settings for this organization</li>
                  <li>Parent/child account relationships</li>
                </ul>
                <span className="block mt-2 text-sm font-medium text-amber-700 dark:text-amber-400">
                  ⚠️ This cannot be undone. We recommend exporting first.
                </span>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter className="flex-col gap-2 sm:flex-row">
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <Button variant="outline" onClick={() => setStep("export")} className="gap-2">
                <Download className="h-4 w-4" />
                Export &amp; Continue
              </Button>
              <Button variant="destructive" onClick={() => setStep("confirm")}>
                Skip Export, Delete
              </Button>
            </AlertDialogFooter>
          </>
        )}

        {/* Step 2: Export */}
        {step === "export" && (
          <>
            <AlertDialogHeader>
              <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-blue-100 dark:bg-blue-900/20">
                <Download className="h-7 w-7 text-blue-600 dark:text-blue-400" />
              </div>
              <AlertDialogTitle className="text-center">Export Before Deleting</AlertDialogTitle>
              <AlertDialogDescription className="text-center">
                Download a CSV backup of all {accounts.length} accounts before proceeding with deletion.
              </AlertDialogDescription>
            </AlertDialogHeader>

            <div className="py-3 flex flex-col gap-3">
              <Button onClick={exportToCSV} variant="outline" className="w-full gap-2" disabled={exportDone}>
                {exportDone ? (
                  <><CheckCircle2 className="h-4 w-4 text-green-600" /> Exported Successfully</>
                ) : (
                  <><Download className="h-4 w-4" /> Download CSV ({accounts.length} accounts)</>
                )}
              </Button>
              {exportDone && (
                <p className="text-xs text-center text-green-600 dark:text-green-400">
                  ✓ Your data has been saved. You may now proceed to delete.
                </p>
              )}
            </div>

            <AlertDialogFooter className="flex-col gap-2 sm:flex-row">
              <Button variant="outline" onClick={() => setStep("warn")}>Go Back</Button>
              <Button
                variant="destructive"
                onClick={() => setStep("confirm")}
                disabled={!exportDone}
              >
                Proceed to Delete
              </Button>
            </AlertDialogFooter>
          </>
        )}

        {/* Step 3: Type to confirm */}
        {step === "confirm" && (
          <>
            <AlertDialogHeader>
              <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-red-100 dark:bg-red-900/20">
                <ShieldAlert className="h-7 w-7 text-red-600 dark:text-red-500" />
              </div>
              <AlertDialogTitle className="text-center">Final Confirmation</AlertDialogTitle>
              <AlertDialogDescription className="text-center">
                Type <strong className="text-foreground font-mono">{confirmPhrase}</strong> to confirm:
              </AlertDialogDescription>
            </AlertDialogHeader>

            <div className="py-4">
              <Label htmlFor="delete-confirm" className="sr-only">Confirmation phrase</Label>
              <Input
                id="delete-confirm"
                value={confirmText}
                onChange={e => setConfirmText(e.target.value)}
                placeholder={confirmPhrase}
                className="text-center font-mono tracking-wider"
                autoComplete="off"
                autoFocus
              />
            </div>

            <AlertDialogFooter className="flex-col gap-2 sm:flex-row">
              <Button variant="outline" onClick={() => setStep("warn")} disabled={isDeleting}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={handleDelete}
                disabled={confirmText !== confirmPhrase || isDeleting}
                className="gap-2"
              >
                {isDeleting ? (
                  <><Loader2 className="h-4 w-4 animate-spin" /> Deleting...</>
                ) : (
                  <><Trash2 className="h-4 w-4" /> Delete All {accounts.length} Accounts</>
                )}
              </Button>
            </AlertDialogFooter>
          </>
        )}

        {/* Step 4: Deleting in progress */}
        {step === "deleting" && (
          <>
            <AlertDialogHeader>
              <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-destructive/10">
                <Loader2 className="h-7 w-7 text-destructive animate-spin" />
              </div>
              <AlertDialogTitle className="text-center">Deleting Accounts…</AlertDialogTitle>
              <AlertDialogDescription className="text-center">
                Removing all accounts and clearing dependencies. Please wait.
              </AlertDialogDescription>
            </AlertDialogHeader>
          </>
        )}

      </AlertDialogContent>
    </AlertDialog>
  );
}
