import { ReactNode } from "react";
import { Lock, AlertTriangle } from "lucide-react";
import { useAppAccess } from "@/hooks/useAppAccess";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Link } from "react-router-dom";

/**
 * SettingsTabGate — wraps any settings panel whose meaning depends on an
 * installed app being available. Implements the Odoo "module-gated
 * configuration" pattern: don't even show settings for apps the org
 * cannot use.
 *
 * Modes:
 *  - mode="hide" (default): renders nothing if the app is not accessible.
 *  - mode="readonly": renders children inside a read-only container with
 *    a banner offering to install/reinstall the app. Useful when the user
 *    needs to *see* historical config (e.g. uninstalled-but-not-deleted).
 *
 * The DB triggers (assert_app_installed_for_write) already enforce this
 * at the row level — this component is the honest UX layer that prevents
 * the user from typing into a form whose save will server-side reject.
 */
interface SettingsTabGateProps {
  appId: string;
  appLabel?: string;
  mode?: "hide" | "readonly";
  children: ReactNode;
}

export function SettingsTabGate({
  appId,
  appLabel,
  mode = "hide",
  children,
}: SettingsTabGateProps) {
  const { hasAppAccess, isLoading } = useAppAccess();

  // Don't flash a "no access" message during the entitlement fetch.
  if (isLoading) return null;

  const accessible = hasAppAccess(appId);

  if (accessible) return <>{children}</>;

  if (mode === "hide") {
    // Caller should also hide the trigger via `useAppAccess().hasAppAccess(appId)`
    // — this is a defensive no-op if they didn't.
    return null;
  }

  // mode === "readonly"
  const label = appLabel ?? appId;
  return (
    <div className="space-y-3">
      <Alert variant="default" className="border-amber-500/40 bg-amber-500/5">
        <AlertTriangle className="h-4 w-4 text-amber-600" />
        <AlertTitle className="text-sm">Read-only — {label} is not installed</AlertTitle>
        <AlertDescription className="text-xs space-y-2">
          <p>
            Existing records remain visible, but you cannot change these settings until the
            <strong> {label}</strong> app is installed for this organization. Installing the
            app keeps your historical data intact.
          </p>
          <Button asChild size="sm" variant="outline" className="mt-2">
            <Link to="/settings/apps">
              <Lock className="mr-2 h-3.5 w-3.5" />
              Manage apps
            </Link>
          </Button>
        </AlertDescription>
      </Alert>
      <div className="pointer-events-none opacity-60 select-none">{children}</div>
    </div>
  );
}
