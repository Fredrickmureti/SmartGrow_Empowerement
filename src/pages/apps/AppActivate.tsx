/**
 * App Activation Page
 *
 * Streamlined one-click activation flow for installing apps.
 * Uses the shared useAppLifecycle hook so the gesture (Install / Start trial /
 * Subscribe / Coming soon) matches the marketplace exactly. No more raw
 * installApp() bypass — addons go through trial-or-subscribe, expired trials
 * route to the upgrade flow.
 *
 * Real configuration happens post-install in each app's Settings page (Odoo pattern).
 */

import { useEffect, useMemo, useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { motion } from "framer-motion";
import { ArrowLeft, Check, Sparkles, Clock, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageContainer } from "@/components/layout/PageContainer";
import { getAppById } from "@/lib/apps/registry";
import { useInstalledApps } from "@/hooks/useInstalledApps";
import { useAppAccess } from "@/hooks/useAppAccess";
import { useAppLifecycle } from "@/hooks/useAppLifecycle";
import { useAppNavigation } from "@/hooks/useAppNavigation";
import { usePermissions } from "@/hooks/usePermissions";
import { AppUnderDevelopment } from "@/components/apps/AppUnderDevelopment";
import { RequestAppAccessDialog } from "@/components/apps/RequestAppAccessDialog";
import { formatAppPrice } from "@/lib/pricing/formatAppPrice";
import { useCurrencyMap } from "@/hooks/useCurrencyMap";

export default function AppActivate() {
  const { appId } = useParams<{ appId: string }>();
  const navigate = useNavigate();
  const { isInstalled } = useInstalledApps();
  const { getAppEntitlementState, getAppPricing, getAppTrial } = useAppAccess();
  const { canAccessApp } = useAppNavigation();
  const { can } = usePermissions();
  const canManageApps = can("manageApps");
  const { currencyMap } = useCurrencyMap();
  const { getAction } = useAppLifecycle({
    onNavigate: (path) => navigate(path),
    onOpenUpgrade: () => navigate("/settings/apps"),
  });
  const [requestAccessOpen, setRequestAccessOpen] = useState(false);

  const app = useMemo(() => (appId ? getAppById(appId) : undefined), [appId]);

  // Already installed → redirect into the app
  useEffect(() => {
    if (app && isInstalled(app.id)) {
      const defaultModule = app.defaultModule
        ? app.modules.find((m) => m.id === app.defaultModule)
        : app.modules[0];
      const defaultPath = `${app.basePath}${defaultModule?.path || ""}`;
      navigate(defaultPath, { replace: true });
    }
  }, [app, isInstalled, navigate]);

  if (!app) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-center">
          <h1 className="text-2xl font-bold mb-2">App not found</h1>
          <p className="text-muted-foreground mb-4">The app you're looking for doesn't exist.</p>
          <Button asChild>
            <Link to="/apps">Back to Apps</Link>
          </Button>
        </div>
      </div>
    );
  }

  const AppIcon = app.icon;
  const entitlementState = getAppEntitlementState(app.id);
  const pricing = getAppPricing(app.id);
  const trial = getAppTrial(app.id);
  const trialDaysLeft = trial?.expires_at
    ? Math.max(0, Math.ceil((new Date(trial.expires_at).getTime() - Date.now()) / 86_400_000))
    : undefined;
  const priceLabel =
    pricing?.monthly_price && pricing.monthly_price > 0
      ? formatAppPrice(Number(pricing.monthly_price), pricing.currency, { perUser: pricing.is_per_user }, currencyMap)
      : "No additional monthly price configured";
  const isComingSoon = app.comingSoon || entitlementState === "coming_soon";

  // Coming soon → fully replace this page with the under-development surface
  // (real explanation, roadmap, notify-me CTA — never the blurred tile + dead "Notify Me").
  if (isComingSoon) {
    const planned = app.modules
      .filter((m) => !m.hidden)
      .slice(0, 4)
      .map((m) => ({ title: m.name, description: m.description ?? "" }));
    return (
      <AppUnderDevelopment
        app={app}
        pitch={app.description}
        roadmap={planned}
        relatedAction={
          app.id === "recruitment"
            ? {
                label: "Need to manage current staff?",
                description:
                  "Use the Employees app to create employee records, departments, and contracts.",
                to: "/hr/employees",
              }
            : undefined
        }
      />
    );
  }

  // Org-installed but the user has no RBAC for this app → offer request-access flow.
  const access = canAccessApp(app);
  const isPermissionLocked =
    isInstalled(app.id) && !access.hasAccess && access.denialReason === "permission";

  // Org has NOT installed the app and the user lacks `manageApps` → they can't
  // install it themselves. Show a clean "request from your administrator"
  // surface instead of bouncing to /home (the old PermissionProtectedRoute trap).
  const isInstallLocked = !isInstalled(app.id) && !canManageApps && !isPermissionLocked;

  // Single source of truth for the activation gesture — same as marketplace.
  const action = getAction(app);
  const showRequestAccessCta = isPermissionLocked || isInstallLocked;

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card/50 backdrop-blur-sm sticky top-0 z-10">
        <PageContainer>
          <div className="flex items-center justify-between h-16">
            <Button variant="ghost" size="sm" onClick={() => navigate("/apps")}>
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back to Apps
            </Button>
            <div className="flex items-center gap-3">
              <div
                className="flex h-8 w-8 items-center justify-center rounded-lg"
                style={{ backgroundColor: `${app.color}20`, color: app.color }}
              >
                <AppIcon className="h-4 w-4" />
              </div>
              <span className="font-medium">{app.name}</span>
            </div>
          </div>
        </PageContainer>
      </header>

      <main className="py-16">
        <PageContainer maxWidth="lg">
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="text-center space-y-8"
          >
            <div className="relative inline-block">
              <motion.div
                initial={{ scale: 0.8 }}
                animate={{ scale: 1 }}
                transition={{ type: "spring", stiffness: 200, damping: 15 }}
                className="inline-flex h-24 w-24 items-center justify-center rounded-full"
                style={{ backgroundColor: `${app.color}15`, color: app.color }}
              >
                <AppIcon className="h-12 w-12" />
              </motion.div>
            </div>

            <div>
              <h1 className="text-3xl font-bold">
                {isPermissionLocked
                  ? `${app.name} — access required`
                  : isInstallLocked
                    ? `${app.name} — admin approval required`
                    : `Activate ${app.name}`}
              </h1>
              <p className="text-muted-foreground mt-2 max-w-md mx-auto">
                {app.description}
                {!showRequestAccessCta && ". You can configure settings after activation."}
              </p>
              <p className="text-sm text-muted-foreground mt-3">
                {!showRequestAccessCta && entitlementState === "in_plan" && "Included in your current subscription."}
                {!showRequestAccessCta && entitlementState === "trial" && `Active trial${trialDaysLeft != null ? ` · ${trialDaysLeft} day(s) left` : ""}.`}
                {!showRequestAccessCta && entitlementState === "addon" && `Available as an add-on · ${priceLabel}.`}
                {!showRequestAccessCta && entitlementState === "expired_trial" && "Trial ended — subscribe to install."}
                {!showRequestAccessCta && entitlementState === "overridden" && "Granted to your organization."}
              </p>
            </div>

            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2 }}
              className="max-w-sm mx-auto bg-muted/50 rounded-lg p-6 space-y-4"
            >
              <h3 className="font-semibold text-sm uppercase tracking-wider text-muted-foreground">
                What's included
              </h3>
              <ul className="space-y-2 text-sm text-left">
                {app.dependsOn && app.dependsOn.length > 0 && (
                  <li className="flex items-start gap-2 text-muted-foreground">
                    <Check className="h-4 w-4 text-primary mt-0.5" />
                    Required apps will be installed or validated automatically: {app.dependsOn.join(", ")}
                  </li>
                )}
                {app.modules.filter((m) => !m.hidden).slice(0, 6).map((mod) => (
                  <li key={mod.id} className="flex items-center gap-2">
                    <Check className="h-4 w-4 text-primary" />
                    {mod.name}
                  </li>
                ))}
                {app.modules.filter((m) => !m.hidden).length > 6 && (
                  <li className="text-muted-foreground">
                    + {app.modules.filter((m) => !m.hidden).length - 6} more modules
                  </li>
                )}
              </ul>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.3 }}
              className="flex flex-col items-center justify-center gap-3 pt-4"
            >
              <div className="flex items-center justify-center gap-3">
                {showRequestAccessCta ? (
                  <Button size="lg" onClick={() => setRequestAccessOpen(true)}>
                    <Lock className="mr-2 h-4 w-4" />
                    Request access from your admin
                  </Button>
                ) : (
                  <>
                    <Button
                      size="lg"
                      onClick={() => void action.onClick()}
                      disabled={action.disabled}
                      style={
                        action.intent === "subscribe" || action.intent === "install"
                          ? { backgroundColor: app.color, color: "white" }
                          : undefined
                      }
                    >
                      {action.label}
                      {action.intent === "install" && <Sparkles className="ml-2 h-4 w-4" />}
                      {action.intent === "start_trial" && <Sparkles className="ml-2 h-4 w-4" />}
                    </Button>
                    {action.secondary && (
                      <Button size="lg" variant="outline" onClick={() => void action.secondary!.onClick()}>
                        {action.secondary.label}
                      </Button>
                    )}
                  </>
                )}
              </div>
              {isPermissionLocked ? (
                <p className="text-xs text-muted-foreground max-w-xs">
                  Your organization has {app.name} installed, but your role doesn't grant access to it yet.
                </p>
              ) : isInstallLocked ? (
                <p className="text-xs text-muted-foreground max-w-xs">
                  {app.name} isn't installed yet. Only an administrator can install apps — request it and they'll be notified.
                </p>
              ) : action.hint ? (
                <p className="text-xs text-muted-foreground max-w-xs">{action.hint}</p>
              ) : null}
            </motion.div>
          </motion.div>
        </PageContainer>
      </main>

      <RequestAppAccessDialog
        open={requestAccessOpen}
        onOpenChange={setRequestAccessOpen}
        app={app}
      />
    </div>
  );
}
