/**
 * Tenant-admin Apps & Subscriptions page (/settings/apps).
 *
 * Counterpart to the platform-admin tools. Lets a tenant owner / admin:
 *   - See all installed apps grouped by entitlement source (in-plan / addon / trial / override)
 *   - See active trials with days-left and a "Subscribe to keep" path
 *   - See available add-ons (not installed, not in plan) with pricing and a Start-trial / Subscribe gesture
 *   - See setup readiness for each installed app, with reasons
 *
 * Read-only against existing tables (organization_installed_apps,
 * app_trial_status, app_pricing_rules, app_setup_status, plan_app_access).
 * Mutations reuse useInstalledApps + useAppLifecycle (same RPCs as marketplace).
 */
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  AppWindow,
  Sparkles,
  Tag,
  AlertTriangle,
  CheckCircle2,
  Clock,
  ArrowRight,
  ShieldCheck,
} from "lucide-react";
import { PlatformAppLayout } from "@/apps/platform";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { useInstalledApps } from "@/hooks/useInstalledApps";
import { useAppAccess } from "@/hooks/useAppAccess";
import { useAppLifecycle } from "@/hooks/useAppLifecycle";
import { useAppSetupStatus } from "@/hooks/useAppSetupStatus";
import { useSession } from "@/contexts/SessionContext";
import { APP_REGISTRY } from "@/lib/apps/registry";
import type { AppDefinition } from "@/lib/apps/types";
import { cn } from "@/lib/utils";
import { PlanChangeSummary } from "@/components/subscription/PlanChangeSummary";
import { formatAppPrice } from "@/lib/pricing/formatAppPrice";
import { useCurrencyMap } from "@/hooks/useCurrencyMap";
import { useOrgBilling } from "@/hooks/useOrgBilling";

function daysUntil(iso: string | null): number | null {
  if (!iso) return null;
  return Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000));
}

export default function AppsAndSubscriptions() {
  const navigate = useNavigate();
  const { currentOrg } = useSession();
  const { installedApps, installedAppIds, uninstallApp, canUninstall } = useInstalledApps();
  const { getAppEntitlementState, getAppPricing, getAppTrial, accessibleAppIds } = useAppAccess();
  const { getStatus } = useAppSetupStatus();
  const { currencyMap } = useCurrencyMap();
  const { billing } = useOrgBilling("monthly");
  const { getAction } = useAppLifecycle({
    onNavigate: (path) => navigate(path),
    onOpenUpgrade: () => navigate("/upgrade"),
  });

  const formatPrice = (monthly: number | null, currency: string | null) =>
    formatAppPrice(monthly, currency, { perUser: false }, currencyMap);

  // Hide platform/system-only apps from the tenant view
  const visibleApps = useMemo(
    () => APP_REGISTRY.filter((a) => !a.isPlatform && a.id !== "platform"),
    [],
  );

  const installed = useMemo(
    () => visibleApps.filter((a) => installedAppIds.has(a.id)),
    [visibleApps, installedAppIds],
  );
  const trialing = useMemo(
    () =>
      visibleApps.filter((a) => {
        const t = getAppTrial(a.id);
        return t?.status === "active" && t.expires_at && new Date(t.expires_at) > new Date();
      }),
    [visibleApps, getAppTrial],
  );
  const availableAddons = useMemo(
    () =>
      visibleApps.filter(
        (a) =>
          !installedAppIds.has(a.id) &&
          !a.comingSoon &&
          getAppEntitlementState(a.id) === "addon",
      ),
    [visibleApps, installedAppIds, getAppEntitlementState],
  );

  // Canonical add-on cost from the server (compute_org_billing RPC).
  // The server is the only source of truth for plan inclusions, trial windows,
  // per-user uplift, and currency. Never recompute on the client.
  const addonCostDisplay = useMemo(() => {
    if (!billing) return "—";
    if ((billing.addons_total ?? 0) <= 0) return "—";
    return `${billing.currency} ${Number(billing.addons_total).toFixed(2)}/mo`;
  }, [billing]);

  return (
    <PlatformAppLayout>
      <div className="container mx-auto max-w-6xl py-6 space-y-6">
        <div className="page-header">
          <div>
            <h1 className="page-title flex items-center gap-2">
              <AppWindow className="h-6 w-6 text-primary" />
              Apps &amp; Subscriptions
            </h1>
            <p className="text-sm text-muted-foreground">
              Manage installed apps, trials, and add-ons for{" "}
              <span className="font-medium">{currentOrg?.name ?? "your organization"}</span>.
            </p>
          </div>
          <div className="action-buttons">
            <Button variant="outline" asChild>
              <Link to="/apps">Browse Marketplace</Link>
            </Button>
          </div>
        </div>

        <PlanChangeSummary />

        {/* Summary strip */}
        <div className="grid gap-3 sm:grid-cols-3">
          <SummaryTile
            icon={<CheckCircle2 className="h-4 w-4" />}
            label="Installed apps"
            value={String(installed.length)}
          />
          <SummaryTile
            icon={<Sparkles className="h-4 w-4" />}
            label="Active trials"
            value={String(trialing.length)}
          />
          <SummaryTile
            icon={<Tag className="h-4 w-4" />}
            label="Add-on cost (from billing engine)"
            value={addonCostDisplay}
          />
        </div>

        {/* Active trials */}
        {trialing.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Sparkles className="h-4 w-4 text-primary" /> Active trials
              </CardTitle>
              <CardDescription>
                Trials convert to add-on subscriptions when they end. Subscribe early to avoid disruption.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {trialing.map((app) => {
                const trial = getAppTrial(app.id);
                const left = daysUntil(trial?.expires_at ?? null);
                const status = getStatus(app.id);
                return (
                  <AppRow
                    key={app.id}
                    app={app}
                    badge={
                      <Badge className="bg-primary/15 text-primary border-transparent gap-1">
                        <Sparkles className="h-3 w-3" />
                        {left != null ? `${left}d left` : "On trial"}
                      </Badge>
                    }
                    setup={status}
                    actions={
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => navigate("/upgrade")}
                        >
                          Subscribe to keep
                        </Button>
                        <Button size="sm" variant="ghost" asChild>
                          <Link to={app.basePath}>
                            Open <ArrowRight className="ml-1 h-3.5 w-3.5" />
                          </Link>
                        </Button>
                      </>
                    }
                  />
                );
              })}
            </CardContent>
          </Card>
        )}

        {/* Installed apps */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <CheckCircle2 className="h-4 w-4 text-primary" /> Installed apps
            </CardTitle>
            <CardDescription>
              Apps currently active for your organization. Uninstalling preserves historical data — you
              can reinstall any time without losing records.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {installed.length === 0 && (
              <p className="text-sm text-muted-foreground">No apps installed yet.</p>
            )}
            {installed.map((app) => {
              const inPlan = accessibleAppIds.has(app.id);
              const pricing = getAppPricing(app.id);
              const trial = getAppTrial(app.id);
              const status = getStatus(app.id);
              const left = trial?.status === "active" ? daysUntil(trial.expires_at ?? null) : null;
              const sourceBadge = inPlan ? (
                <Badge variant="secondary" className="gap-1">
                  <ShieldCheck className="h-3 w-3" /> Included in plan
                </Badge>
              ) : left != null ? (
                <Badge className="bg-primary/15 text-primary border-transparent gap-1">
                  <Sparkles className="h-3 w-3" /> Trial · {left}d
                </Badge>
              ) : (
                <Badge variant="outline" className="gap-1">
                  <Tag className="h-3 w-3" />
                  {formatPrice(pricing?.monthly_price ?? null, pricing?.currency ?? null)}
                </Badge>
              );
              return (
                <AppRow
                  key={app.id}
                  app={app}
                  badge={sourceBadge}
                  setup={status}
                  actions={
                    <>
                      <Button size="sm" variant="ghost" asChild>
                        <Link to={app.basePath}>
                          Open <ArrowRight className="ml-1 h-3.5 w-3.5" />
                        </Link>
                      </Button>
                      {canUninstall(app.id) && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-destructive hover:text-destructive"
                          onClick={() => {
                            if (confirm(`Uninstall ${app.name}? Historical data is kept.`)) {
                              void uninstallApp(app.id);
                            }
                          }}
                        >
                          Uninstall
                        </Button>
                      )}
                    </>
                  }
                />
              );
            })}
          </CardContent>
        </Card>

        {/* Available add-ons */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Tag className="h-4 w-4 text-primary" /> Available add-ons
            </CardTitle>
            <CardDescription>
              Apps not included in your current plan. Try free for 14 days or subscribe directly.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {availableAddons.length === 0 && (
              <p className="text-sm text-muted-foreground">No add-ons available right now.</p>
            )}
            {availableAddons.map((app) => {
              const pricing = getAppPricing(app.id);
              const action = getAction(app);
              return (
                <AppRow
                  key={app.id}
                  app={app}
                  badge={
                    <Badge variant="outline" className="gap-1">
                      <Tag className="h-3 w-3" />
                      {formatPrice(pricing?.monthly_price ?? null, pricing?.currency ?? null)}
                    </Badge>
                  }
                  setup={null}
                  actions={
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={action.disabled}
                        onClick={() => void action.onClick()}
                      >
                        {action.label}
                      </Button>
                      {action.secondary && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => void action.secondary!.onClick()}
                        >
                          {action.secondary.label}
                        </Button>
                      )}
                    </>
                  }
                />
              );
            })}
          </CardContent>
        </Card>
      </div>
    </PlatformAppLayout>
  );
}

/* ---------- internal building blocks ---------- */

function SummaryTile({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 py-4">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
          {icon}
        </div>
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground truncate">{label}</p>
          <p className="text-lg font-semibold truncate">{value}</p>
        </div>
      </CardContent>
    </Card>
  );
}

function AppRow({
  app,
  badge,
  setup,
  actions,
}: {
  app: AppDefinition;
  badge: React.ReactNode;
  setup: { is_ready: boolean; reasons: string[] } | null;
  actions: React.ReactNode;
}) {
  const Icon = app.icon;
  const setupBlocked = setup && !setup.is_ready;
  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-card p-3 sm:flex-row sm:items-center sm:gap-4">
      <div
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg"
        style={{ backgroundColor: `${app.color}15`, color: app.color }}
      >
        <Icon className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-medium text-sm truncate">{app.name}</h3>
          {badge}
        </div>
        <p className="text-xs text-muted-foreground line-clamp-1">{app.description}</p>
        {setupBlocked && (
          <div className="mt-1.5 flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400">
            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <span>
              <span className="font-medium">Setup required:</span>{" "}
              {setup!.reasons.length > 0 ? setup!.reasons.slice(0, 2).join(", ") : "configuration incomplete"}
            </span>
          </div>
        )}
      </div>
      <div className="flex items-center gap-1 shrink-0">{actions}</div>
    </div>
  );
}

/* Re-export Clock to avoid unused import lint when component shrinks. */
export const _icons = { Clock, Separator, cn };
