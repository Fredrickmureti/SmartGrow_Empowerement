/**
 * TenantReadinessGate
 *
 * Wraps children that depend on a fully provisioned tenant (user has a
 * resolvable organization + business + role) and renders a deterministic
 * "Finishing tenant setup…" state with a retry button until the
 * `useTenantReadiness` probe reports `ready`.
 *
 * Use to gate destructive / provisioning-sensitive UI such as the
 * localization-pack install button. This converts the previously silent
 * fresh-tenant 401 / 403 race into an explained UX state.
 */
import { Loader2, AlertCircle, RefreshCw } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  useTenantReadiness,
  type UseTenantReadinessOptions,
} from "@/hooks/useTenantReadiness";

interface TenantReadinessGateProps extends UseTenantReadinessOptions {
  children: React.ReactNode;
  /** Optional compact mode for inline use inside another card. */
  compact?: boolean;
}

export function TenantReadinessGate({
  children,
  compact = false,
  ...options
}: TenantReadinessGateProps) {
  const { state, retry, reason } = useTenantReadiness(options);

  if (state === "ready") return <>{children}</>;

  const body = (
    <div className="flex items-start gap-3 text-sm">
      {state === "timed_out" ? (
        <AlertCircle className="h-4 w-4 mt-0.5 text-amber-600 shrink-0" />
      ) : (
        <Loader2 className="h-4 w-4 mt-0.5 animate-spin text-muted-foreground shrink-0" />
      )}
      <div className="flex-1 space-y-2">
        <div>
          <div className="font-medium">
            {state === "timed_out"
              ? "Tenant setup taking longer than expected"
              : "Finishing tenant setup…"}
          </div>
          <p className="text-muted-foreground">
            {state === "timed_out"
              ? "Your workspace is still being provisioned. Wait a moment, then retry."
              : reason || "Waiting for your workspace to become queryable."}
          </p>
        </div>
        {state === "timed_out" && (
          <Button size="sm" variant="outline" onClick={retry}>
            <RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Retry
          </Button>
        )}
      </div>
    </div>
  );

  if (compact) {
    return (
      <div
        className={
          "rounded-md border p-3 " +
          (state === "timed_out"
            ? "border-amber-500/40 bg-amber-500/10"
            : "border-muted bg-muted/30")
        }
      >
        {body}
      </div>
    );
  }

  return (
    <Card>
      <CardContent className="py-4">{body}</CardContent>
    </Card>
  );
}

export default TenantReadinessGate;
