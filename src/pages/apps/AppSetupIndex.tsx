/**
 * App Setup overview (`/apps/setup`)
 *
 * Landing surface for the platform nav "App Setup" entry. Lists every
 * installed app with its `app_setup_status` summary and deep links into the
 * per-app checklist at `/apps/:appId/setup`.
 */

import { useMemo } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, CheckCircle2, ChevronRight, Wrench } from "lucide-react";
import { PlatformAppLayout } from "@/apps/platform";
import { PageContainer } from "@/components/layout/PageContainer";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { APP_REGISTRY } from "@/lib/apps/registry";
import { useAppSetupStatus } from "@/hooks/useAppSetupStatus";
import { useInstalledApps } from "@/hooks/useInstalledApps";

export default function AppSetupIndex() {
  // eslint-disable-next-line local/no-raw-installed-apps-loading-gate -- decoration: composite spinner, page itself is not gated
  const { installedApps, isLoading: installsLoading } = useInstalledApps();
  const { getCardSummary, isLoading: setupLoading } = useAppSetupStatus();

  const isLoading = installsLoading || setupLoading;

  const apps = useMemo(() => {
    const installedIds = new Set(installedApps.map((a) => a.app_id));
    return APP_REGISTRY.filter((app) => installedIds.has(app.id)).map((app) => {
      const summary = getCardSummary(app.id);
      return {
        app,
        isReady: summary?.isReady ?? true,
        reasons: summary?.reasons ?? [],
        tracked: summary !== null,
      };
    });
  }, [installedApps, getCardSummary]);

  const needsSetup = apps.filter((a) => !a.isReady);

  return (
    <PlatformAppLayout>
      <PageContainer>
        <div className="mb-6 flex items-start gap-4">
          <div className="h-12 w-12 rounded-xl bg-primary/10 text-primary flex items-center justify-center">
            <Wrench className="h-6 w-6" />
          </div>
          <div className="flex-1">
            <h1 className="text-2xl font-semibold">App setup</h1>
            <p className="text-sm text-muted-foreground">
              Configuration status for every installed app. Open an app to see
              its outstanding setup tasks.
            </p>
          </div>
          {!isLoading && (
            <Badge variant={needsSetup.length ? "secondary" : "default"}>
              {needsSetup.length
                ? `${needsSetup.length} need setup`
                : "All apps ready"}
            </Badge>
          )}
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Installed apps</CardTitle>
            <CardDescription>
              Setup status is refreshed automatically as you complete
              configuration in each app.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-3">
                <Skeleton className="h-14 w-full" />
                <Skeleton className="h-14 w-full" />
                <Skeleton className="h-14 w-full" />
              </div>
            ) : apps.length === 0 ? (
              <div className="text-center py-10">
                <p className="text-muted-foreground mb-4">
                  No apps installed yet.
                </p>
                <Button asChild>
                  <Link to="/apps">Browse the marketplace</Link>
                </Button>
              </div>
            ) : (
              <ul className="divide-y">
                {apps.map(({ app, isReady, reasons }) => {
                  const AppIcon = app.icon;
                  return (
                    <li key={app.id}>
                      <Link
                        to={`/apps/${app.id}/setup`}
                        className="flex items-center gap-3 py-3 hover:bg-muted/50 rounded-md px-2 -mx-2 transition-colors"
                      >
                        <div
                          className="h-10 w-10 rounded-lg flex items-center justify-center shrink-0"
                          style={{ backgroundColor: `${app.color}20`, color: app.color }}
                        >
                          <AppIcon className="h-5 w-5" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium">{app.name}</p>
                          <p className="text-xs text-muted-foreground truncate">
                            {isReady
                              ? "No outstanding setup tasks"
                              : reasons.slice(0, 2).join(" · ") || "Setup required"}
                          </p>
                        </div>
                        {isReady ? (
                          <CheckCircle2 className="h-4 w-4 text-success shrink-0" />
                        ) : (
                          <AlertTriangle className="h-4 w-4 text-warning shrink-0" />
                        )}
                        <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      </PageContainer>
    </PlatformAppLayout>
  );
}
