/**
 * UninstallAppDialog — safety dialog for app uninstall.
 *
 * Two states:
 *   1. BLOCKED — one or more installed apps depend on this app. Show
 *      remediation: "Uninstall POS first" (with quick links).
 *   2. CONFIRM — safe to uninstall. Reassure the user that historical
 *      data is preserved (Odoo `uninstall keeps records` pattern):
 *        "Your invoices, payslips, journal entries stay intact and
 *         remain readable / exportable from your reports."
 *
 * Triggers `uninstall_app` RPC on confirm. The DB function also has a
 * matching guard (`block_app_uninstall_if_dependents_active` trigger),
 * so this dialog is purely UX — backend remains authoritative.
 */
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
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, Loader2, Archive, Lock } from "lucide-react";
import { useUninstallBlockers } from "@/hooks/useAppLifecyclePreview";

interface UninstallAppDialogProps {
  appId: string | null;
  appName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => Promise<void> | void;
  isUninstalling?: boolean;
}

export function UninstallAppDialog({
  appId,
  appName,
  open,
  onOpenChange,
  onConfirm,
  isUninstalling = false,
}: UninstallAppDialogProps) {
  const { data: blockers = [], isLoading } = useUninstallBlockers(appId);
  const isBlocked = blockers.length > 0;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="sm:max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            {isBlocked ? (
              <Lock className="h-5 w-5 text-amber-600" />
            ) : (
              <Archive className="h-5 w-5 text-muted-foreground" />
            )}
            {isBlocked ? `Can't uninstall ${appName}` : `Uninstall ${appName}?`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {isBlocked
              ? "Other installed apps require this one. Uninstall the dependent apps first."
              : "Your historical data is safe. Read on for what changes."}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {isLoading && (
          <div className="flex items-center justify-center py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
            Checking dependencies…
          </div>
        )}

        {!isLoading && isBlocked && (
          <div className="space-y-3">
            <div className="rounded-md border border-amber-200 dark:border-amber-900/40 bg-amber-50 dark:bg-amber-950/20 p-3 text-sm">
              <div className="flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
                <div className="space-y-1.5">
                  <p className="font-medium text-amber-900 dark:text-amber-200">
                    {blockers.length === 1
                      ? `${blockers[0].blocking_app_name} requires ${appName}.`
                      : `${blockers.length} installed apps require ${appName}.`}
                  </p>
                  <p className="text-amber-800/90 dark:text-amber-200/80 text-xs">
                    Uninstall {blockers.length === 1 ? "it" : "them"} first, then
                    you can remove {appName}.
                  </p>
                </div>
              </div>
            </div>

            <div className="space-y-1.5">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Apps blocking this uninstall
              </p>
              <ul className="space-y-1.5 rounded-md border bg-muted/30 p-2.5">
                {blockers.map((b) => (
                  <li
                    key={b.blocking_app_id}
                    className="flex items-center justify-between text-sm"
                  >
                    <span className="font-medium">{b.blocking_app_name}</span>
                    <Badge variant="outline" className="h-5 text-[10px]">
                      Required
                    </Badge>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        {!isLoading && !isBlocked && (
          <div className="space-y-3 text-sm">
            <div className="rounded-md border bg-muted/30 p-3 space-y-1.5">
              <p className="font-medium text-foreground flex items-center gap-1.5">
                <Archive className="h-4 w-4" />
                Your data stays
              </p>
              <p className="text-muted-foreground text-xs leading-relaxed">
                Existing records (invoices, journal entries, payslips, etc.)
                remain stored. Reports continue to read them. You can re-install
                the app any time to resume creating new records.
              </p>
            </div>
            <p className="text-xs text-muted-foreground">
              The app menu will be removed from your sidebar. Routes will redirect
              to the marketplace until you re-install.
            </p>
          </div>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={isUninstalling}>
            {isBlocked ? "Got it" : "Cancel"}
          </AlertDialogCancel>
          {!isBlocked && (
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                onConfirm();
              }}
              disabled={isUninstalling || isLoading}
              className="bg-destructive hover:bg-destructive/90"
            >
              {isUninstalling ? (
                <>
                  <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                  Uninstalling…
                </>
              ) : (
                "Uninstall"
              )}
            </AlertDialogAction>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
