/**
 * useAppLifecycle Hook
 *
 * Resolves the correct UI gesture for an app card based on its 5-state
 * entitlement state + install status. This is the single place that
 * decides "what does the primary button do" — keeping AppCard /
 * AppMarketplace / AppActivate consistent.
 *
 * State → action mapping (Odoo + Xero hybrid):
 *
 *   in_plan + !installed       → "Install"           install_app RPC
 *   in_plan + installed        → "Open"              navigate to app
 *   overridden + !installed    → "Install"           install_app RPC (override grants entitlement)
 *   trial (active) + !installed→ "Install (trial)"   install_app (entitlement check passes via trial row)
 *   trial (active) + installed → "Open"              navigate; show days-left chip
 *   addon + !installed         → primary "Start free trial"  (start_app_trial then install_app)
 *                              + secondary "Subscribe"        (opens upgrade flow)
 *   addon + installed          → "Open"              (already paid for / grace)
 *   expired_trial              → "Subscribe to keep using"   (opens upgrade flow). Install disabled.
 *   coming_soon                → disabled tile.
 *
 * NOTE: This hook does NOT itself call RPCs — it returns descriptors
 * (label, intent, onClick). The caller wires onClick to mutations from
 * useInstalledApps + a subscription/upgrade dialog opener.
 */

import { useCallback } from "react";
import { useSession } from "@/contexts/SessionContext";
import { useAppAccess, type AppEntitlementState } from "@/hooks/useAppAccess";
import { useInstalledApps } from "@/hooks/useInstalledApps";
import type { AppDefinition } from "@/lib/apps/types";

export type AppLifecycleIntent =
  | "install"
  | "open"
  | "start_trial"
  | "subscribe"
  | "disabled";

export interface AppLifecycleAction {
  /** Primary button label */
  label: string;
  /** Semantic intent — drives styling and analytics */
  intent: AppLifecycleIntent;
  /** Whether the primary action is disabled */
  disabled: boolean;
  /** Click handler. May be async. */
  onClick: () => Promise<void> | void;
  /** Optional secondary action (e.g. "Subscribe" next to "Start trial") */
  secondary?: {
    label: string;
    intent: AppLifecycleIntent;
    onClick: () => Promise<void> | void;
  };
  /** Tooltip / status hint */
  hint?: string;
}

interface UseAppLifecycleOptions {
  /** Called when user picks "Subscribe" / upgrade flow */
  onOpenUpgrade?: (appId: string) => void;
  /** Called after install/open succeeds, with the path to navigate to */
  onNavigate?: (path: string) => void;
}

/**
 * Resolve actions for one app. Returns a function rather than an object
 * so the same hook instance can be reused across many cards.
 */
export function useAppLifecycle(options: UseAppLifecycleOptions = {}) {
  const { currentOrg: _currentOrg } = useSession();
  const { isInstalled, installApp } = useInstalledApps();
  const { getAppEntitlementState, getAppTrial } = useAppAccess();
  void _currentOrg;

  const resolveAppPath = useCallback((app: AppDefinition): string => {
    const defaultModule = app.defaultModule
      ? app.modules.find((m) => m.id === app.defaultModule)
      : app.modules[0];
    return `${app.basePath}${defaultModule?.path || ""}`;
  }, []);

  const getAction = useCallback(
    (app: AppDefinition): AppLifecycleAction => {
      const installed = isInstalled(app.id);
      const state: AppEntitlementState = getAppEntitlementState(app.id);
      const path = resolveAppPath(app);

      // Coming soon — never installable
      if (state === "coming_soon" || app.comingSoon) {
        return {
          label: "Coming soon",
          intent: "disabled",
          disabled: true,
          onClick: () => {},
          hint: "This app is announced but not available yet.",
        };
      }

      // Already installed — primary is always Open (regardless of plan/addon/trial)
      if (installed) {
        const trial = getAppTrial(app.id);
        const trialDays =
          trial?.expires_at && trial.status === "active"
            ? Math.max(
                0,
                Math.ceil(
                  (new Date(trial.expires_at).getTime() - Date.now()) / 86_400_000,
                ),
              )
            : null;
        return {
          label: "Open",
          intent: "open",
          disabled: false,
          onClick: () => options.onNavigate?.(path),
          hint:
            trialDays != null
              ? `On trial — ${trialDays} day(s) remaining`
              : undefined,
        };
      }

      // Not installed — branch on entitlement state
      switch (state) {
        case "in_plan":
        case "overridden":
        case "trial":
          // Plan/override grants direct install. Trial branch passes the same
          // RPC entitlement check (assert_entitlement reads app_trial_status).
          return {
            label: "Install",
            intent: "install",
            disabled: false,
            onClick: async () => {
              try {
                await installApp(app.id);
                options.onNavigate?.(path);
              } catch {
                /* useInstalledApps surfaces a structured toast */
              }
            },
          };

        case "addon":
          // Primary: install — the install_app RPC starts trials atomically
          // for the requested app + any trialable dependencies. The user
          // confirms scope first via InstallAppDialog (preview_install_impact).
          return {
            label: "Start free trial",
            intent: "start_trial",
            disabled: false,
            onClick: async () => {
              try {
                await installApp(app.id);
                options.onNavigate?.(path);
              } catch {
                /* useInstalledApps surfaces a structured toast */
              }
            },
            secondary: {
              label: "Subscribe",
              intent: "subscribe",
              onClick: () => options.onOpenUpgrade?.(app.id),
            },
            hint: "14-day free trial. Subscribe anytime to keep using it.",
          };

        case "expired_trial":
          return {
            label: "Subscribe to install",
            intent: "subscribe",
            disabled: false,
            onClick: () => options.onOpenUpgrade?.(app.id),
            hint:
              "Trial ended. Subscribe to this app or upgrade your plan to install.",
          };

        default:
          return {
            label: "Install",
            intent: "install",
            disabled: true,
            onClick: () => {},
          };
      }
    },
    [
      getAppEntitlementState,
      getAppTrial,
      isInstalled,
      installApp,
      options,
      resolveAppPath,
    ],
  );

  return { getAction };
}
