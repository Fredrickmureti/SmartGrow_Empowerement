/**
 * AppTrialBanner
 *
 * Per-app trial state banner shown inside the workspace shell:
 *   - Active trial: "Trial ends in N day(s)" with Subscribe CTA
 *   - Expired trial: "Trial ended — read-only access" with Subscribe CTA
 *
 * Renders nothing when the app is `in_plan`, `overridden`, or has no trial row.
 * Complements the org-level SubscriptionReadOnlyBanner (which is plan-wide),
 * by surfacing per-app trial state that org-level banners can't express.
 */
import { useNavigate } from "react-router-dom";
import { Sparkles, Clock, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAppAccess } from "@/hooks/useAppAccess";
import { cn } from "@/lib/utils";

interface AppTrialBannerProps {
  appId: string;
  appName: string;
  className?: string;
}

export function AppTrialBanner({ appId, appName, className }: AppTrialBannerProps) {
  const navigate = useNavigate();
  const { getAppEntitlementState, getAppTrial } = useAppAccess();
  const state = getAppEntitlementState(appId);
  const trial = getAppTrial(appId);

  if (state !== "trial" && state !== "expired_trial") return null;

  const daysLeft =
    trial?.expires_at
      ? Math.max(0, Math.ceil((new Date(trial.expires_at).getTime() - Date.now()) / 86_400_000))
      : null;

  const handleUpgrade = () => navigate(`/apps/${appId}/upgrade`);

  if (state === "expired_trial") {
    return (
      <div
        className={cn(
          "flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-2.5 mb-4",
          className,
        )}
      >
        <div className="flex items-center gap-2.5 text-sm">
          <Lock className="h-4 w-4 text-destructive shrink-0" />
          <span>
            <span className="font-medium">{appName} trial ended.</span>{" "}
            <span className="text-muted-foreground">
              Read-only — subscribe to restore full access.
            </span>
          </span>
        </div>
        <Button size="sm" onClick={handleUpgrade}>
          <Sparkles className="mr-1.5 h-3.5 w-3.5" />
          Subscribe
        </Button>
      </div>
    );
  }

  // Active trial — emphasise urgency only when ≤7 days
  const isUrgent = daysLeft !== null && daysLeft <= 7;
  return (
    <div
      className={cn(
        "flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 rounded-lg border px-4 py-2.5 mb-4",
        isUrgent
          ? "border-amber-300 bg-amber-50 dark:border-amber-900/40 dark:bg-amber-950/20"
          : "border-primary/20 bg-primary/5",
        className,
      )}
    >
      <div className="flex items-center gap-2.5 text-sm">
        <Clock
          className={cn(
            "h-4 w-4 shrink-0",
            isUrgent ? "text-amber-700 dark:text-amber-400" : "text-primary",
          )}
        />
        <span>
          <span className="font-medium">{appName} trial</span>
          {daysLeft != null && (
            <>
              {" — "}
              <span className={isUrgent ? "text-amber-800 dark:text-amber-300" : "text-muted-foreground"}>
                {daysLeft === 0
                  ? "ends today"
                  : daysLeft === 1
                    ? "ends tomorrow"
                    : `${daysLeft} days left`}
              </span>
            </>
          )}
        </span>
      </div>
      <Button size="sm" variant={isUrgent ? "default" : "outline"} onClick={handleUpgrade}>
        <Sparkles className="mr-1.5 h-3.5 w-3.5" />
        Subscribe
      </Button>
    </div>
  );
}
