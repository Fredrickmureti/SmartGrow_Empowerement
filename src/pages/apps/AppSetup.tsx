/**
 * App Setup Checklist (`/apps/:appId/setup`)
 *
 * One unified setup surface per app. Driven entirely by
 * `app_setup_status.blocking_reasons` so each app's setup script
 * (e.g. `refresh_payroll_setup_status`) controls what shows up here —
 * no per-app hard-coded UI.
 *
 * Renders:
 *  - App identity (icon, name, description)
 *  - Lifecycle banner (read_only / grace / expired_trial / suspended)
 *  - Checklist of `blocking_reasons` with deep links to the canonical
 *    settings page for each reason (best-effort heuristic).
 *  - "Open app anyway" CTA — read-only views remain accessible even when
 *    setup is incomplete (Odoo pattern).
 */

import { useMemo } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, CheckCircle2, AlertTriangle, Settings as SettingsIcon, ExternalLink } from "lucide-react";
import { PlatformAppLayout } from "@/apps/platform";
import { PageContainer } from "@/components/layout/PageContainer";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { getAppById } from "@/lib/apps/registry";
import { useAppSetupStatus } from "@/hooks/useAppSetupStatus";
import { useInstalledApps } from "@/hooks/useInstalledApps";
import { useAppLifecycleState } from "@/hooks/useAppLifecycleState";

/**
 * Best-effort mapping of common blocking-reason keywords to canonical
 * settings deep links. Falls back to the app's own settings module.
 */
function suggestLink(appId: string, reason: string, appBasePath: string): string {
  const r = reason.toLowerCase();
  if (r.includes("chart of accounts") || r.includes("gl ") || r.includes("ledger")) return "/finance/accounts";
  if (r.includes("tax")) return "/finance/settings";
  if (r.includes("currency")) return "/settings/company";
  if (r.includes("salary") || r.includes("payroll component")) return "/hr/payroll/configuration";
  if (r.includes("statutory") || r.includes("nssf") || r.includes("paye") || r.includes("nhif") || r.includes("shif")) return "/hr/payroll/statutory-rules";
  if (r.includes("employee")) return "/hr/employees";
  if (r.includes("location") || r.includes("warehouse")) return "/inventory-app/locations";
  if (r.includes("price list") || r.includes("price-list")) return "/sales/price-lists";
  if (r.includes("payment provider") || r.includes("mpesa") || r.includes("stripe")) return "/settings/company";
  return `${appBasePath}/settings`;
}

function LifecycleBanner({ state }: { state: string }) {
  if (state === "active" || state === "trial") return null;
  const messages: Record<string, { title: string; tone: "warning" | "destructive" }> = {
    grace: { title: "Subscription past due — actions still allowed during grace period.", tone: "warning" },
    read_only: { title: "Read-only mode — subscription has expired. Renew to make changes.", tone: "destructive" },
    expired_trial: { title: "Trial ended — subscribe to continue using this app.", tone: "destructive" },
    suspended: { title: "Organization is suspended.", tone: "destructive" },
    not_installed: { title: "This app is not installed yet.", tone: "warning" },
  };
  const m = messages[state];
  if (!m) return null;
  return (
    <div
      role="alert"
      className={`mb-6 rounded-md border px-4 py-3 text-sm flex items-start gap-2 ${
        m.tone === "destructive"
          ? "border-destructive/40 bg-destructive/10 text-destructive"
          : "border-warning/40 bg-warning/10 text-warning-foreground"
      }`}
    >
      <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
      <span>{m.title}</span>
    </div>
  );
}

export default function AppSetup() {
  const { appId } = useParams<{ appId: string }>();
  const navigate = useNavigate();
  const app = useMemo(() => (appId ? getAppById(appId) : undefined), [appId]);
  // eslint-disable-next-line local/no-raw-installed-apps-loading-gate -- decoration: composite spinner, gating handled upstream by AppInstalledGate
  const { isInstalled, isLoading: installsLoading } = useInstalledApps();
  const { getCardSummary, isLoading: setupLoading } = useAppSetupStatus();
  const { state, isLoading: stateLoading } = useAppLifecycleState(appId);

  if (!app) {
    return (
      <PlatformAppLayout>
        <PageContainer>
          <div className="text-center py-16">
            <h1 className="text-2xl font-semibold mb-2">App not found</h1>
            <p className="text-muted-foreground mb-4">
              The app you're looking for doesn't exist.
            </p>
            <Button asChild>
              <Link to="/apps">Back to Apps</Link>
            </Button>
          </div>
        </PageContainer>
      </PlatformAppLayout>
    );
  }

  const isLoading = installsLoading || setupLoading || stateLoading;
  const installed = isInstalled(app.id);
  const summary = getCardSummary(app.id);
  const reasons = summary?.reasons ?? [];
  const isReady = installed && (summary?.isReady ?? true);
  const AppIcon = app.icon;

  const openApp = () => navigate(app.basePath);

  return (
    <PlatformAppLayout>
      <PageContainer>
        <div className="mb-6">
          <Button variant="ghost" size="sm" asChild>
            <Link to="/apps">
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back to Apps
            </Link>
          </Button>
        </div>

        <div className="flex items-center gap-4 mb-6">
          <div
            className="h-14 w-14 rounded-xl flex items-center justify-center"
            style={{ backgroundColor: `${app.color}20`, color: app.color }}
          >
            <AppIcon className="h-7 w-7" />
          </div>
          <div className="flex-1">
            <h1 className="text-2xl font-semibold">{app.name} setup</h1>
            <p className="text-sm text-muted-foreground">{app.description}</p>
          </div>
          <Badge variant={isReady ? "default" : "secondary"}>
            {isLoading ? "Checking…" : isReady ? "Ready" : "Setup required"}
          </Badge>
        </div>

        <LifecycleBanner state={state} />

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <SettingsIcon className="h-5 w-5" />
              Setup checklist
            </CardTitle>
            <CardDescription>
              Complete the items below so {app.name} can post correctly and
              be fully usable. You can still open the app to view existing
              data while finishing setup.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-3">
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
              </div>
            ) : !installed ? (
              <div className="text-center py-8">
                <p className="text-muted-foreground mb-4">
                  Install {app.name} first to see its setup checklist.
                </p>
                <Button onClick={() => navigate(`/apps/${app.id}/activate`)}>
                  Install {app.name}
                </Button>
              </div>
            ) : reasons.length === 0 ? (
              <div className="flex items-center gap-3 py-6 text-success">
                <CheckCircle2 className="h-6 w-6" />
                <div>
                  <p className="font-medium text-foreground">All set.</p>
                  <p className="text-sm text-muted-foreground">
                    {app.name} has no outstanding setup tasks.
                  </p>
                </div>
              </div>
            ) : (
              <ul className="divide-y">
                {reasons.map((reason, idx) => {
                  const href = suggestLink(app.id, reason, app.basePath);
                  return (
                    <li key={idx} className="py-3 flex items-start gap-3">
                      <span className="mt-0.5 h-5 w-5 rounded-full border-2 border-muted-foreground/40 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm">{reason}</p>
                      </div>
                      <Button variant="outline" size="sm" asChild>
                        <Link to={href}>
                          Resolve <ExternalLink className="h-3 w-3 ml-1.5" />
                        </Link>
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>

        {installed && (
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="outline" onClick={openApp}>
              Open {app.name} (read-only OK)
            </Button>
            <Button asChild>
              <Link to={`${app.basePath}/settings`}>Open {app.name} settings</Link>
            </Button>
          </div>
        )}
      </PageContainer>
    </PlatformAppLayout>
  );
}
