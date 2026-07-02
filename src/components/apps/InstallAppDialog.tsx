/**
 * InstallAppDialog — preflight dialog for app installation.
 *
 * Shows the user the full dependency closure (transitive deps + the app
 * itself) with billing impact lines so they can confirm:
 *
 *   Installing **Payroll** will also install:
 *     ✓ Employees (already installed)
 *     ✓ Finance (included in your plan)
 *     💲 Add-on: priced from `app_pricing_rules` (admin-controlled), with a
 *        14-day free trial when applicable.
 *
 * Single confirm triggers `install_app`, which already auto-installs deps
 * server-side. Errors are translated into friendly copy.
 */
import { useMemo } from "react";
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
import { Loader2, Check, Package, Sparkles, AlertTriangle } from "lucide-react";
import { useInstallPreview, type InstallPreviewLine } from "@/hooks/useAppLifecyclePreview";
import { cn } from "@/lib/utils";

interface InstallAppDialogProps {
  /** App ID to install. When null/empty, dialog is closed. */
  appId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Confirms install. Caller wires this to install_app mutation. */
  onConfirm: () => Promise<void> | void;
  isInstalling?: boolean;
}

function LineIcon({ line }: { line: InstallPreviewLine }) {
  if (line.is_installed) {
    return <Check className="h-4 w-4 text-emerald-600" aria-label="Already installed" />;
  }
  if (line.billing_behavior === "in_plan") {
    return <Check className="h-4 w-4 text-emerald-600" aria-label="Included" />;
  }
  if (line.billing_behavior === "trial_eligible") {
    return <Sparkles className="h-4 w-4 text-amber-600" aria-label="Trial eligible add-on" />;
  }
  return <AlertTriangle className="h-4 w-4 text-orange-600" aria-label="Add-on required" />;
}

export function InstallAppDialog({
  appId,
  open,
  onOpenChange,
  onConfirm,
  isInstalling = false,
}: InstallAppDialogProps) {
  const { preview, isLoading, error } = useInstallPreview(appId);

  const rootLine = useMemo(
    () => preview?.lines.find((l) => l.is_root),
    [preview],
  );
  const depLines = useMemo(
    () => preview?.lines.filter((l) => !l.is_root) ?? [],
    [preview],
  );

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="sm:max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <Package className="h-5 w-5 text-primary" />
            Install {rootLine?.app_name ?? "app"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            Review what will happen, then confirm to install.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {isLoading && (
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin mr-2" />
            Checking dependencies…
          </div>
        )}

        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            Couldn't load install preview. You can still try to install — the
            server will validate dependencies and entitlements.
          </div>
        )}

        {preview && !isLoading && (
          <div className="space-y-4">
            {/* Dependency lines (shown first if any) */}
            {depLines.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Required apps
                </p>
                <ul className="space-y-1.5 rounded-md border bg-muted/30 p-2.5">
                  {depLines.map((line) => (
                    <li
                      key={line.app_id}
                      className="flex items-start gap-2.5 text-sm"
                    >
                      <span className="mt-0.5">
                        <LineIcon line={line} />
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{line.app_name}</span>
                          {line.is_installed && (
                            <Badge variant="outline" className="h-4 px-1 text-[10px]">
                              Installed
                            </Badge>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {line.billing_label}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Root app line */}
            {rootLine && (
              <div className="space-y-1.5">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  This app
                </p>
                <div
                  className={cn(
                    "flex items-start gap-2.5 rounded-md border bg-card p-2.5",
                    !rootLine.is_entitled &&
                      "border-amber-200 dark:border-amber-900/40",
                  )}
                >
                  <span className="mt-0.5">
                    <LineIcon line={rootLine} />
                  </span>
                  <div className="flex-1">
                    <div className="font-medium">{rootLine.app_name}</div>
                    <p className="text-xs text-muted-foreground">
                      {rootLine.billing_label}
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* Footer hint */}
            <p className="text-xs text-muted-foreground">
              {preview.apps_to_install === 0
                ? "All apps already installed — opening workspace."
                : preview.apps_to_install === 1
                  ? "1 app will be installed."
                  : `${preview.apps_to_install} apps will be installed in the correct order.`}
            </p>
          </div>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={isInstalling}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              onConfirm();
            }}
            disabled={isInstalling || isLoading}
          >
            {isInstalling ? (
              <>
                <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                Installing…
              </>
            ) : preview?.apps_to_install === 0 ? (
              "Open"
            ) : (
              `Install ${preview?.apps_to_install ?? ""} app${preview?.apps_to_install === 1 ? "" : "s"}`
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
