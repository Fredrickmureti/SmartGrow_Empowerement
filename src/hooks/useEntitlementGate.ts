/**
 * useEntitlementGate Hook
 *
 * Single source of truth for write-action UI gating across the app.
 * Use this BEFORE rendering an action button (Run Payroll, Create Invoice,
 * Sell at POS, etc.) so the user sees a clean upgrade / setup prompt
 * instead of a backend 403 / 422.
 *
 * Backend RLS + edge-function entitlement checks remain authoritative.
 * This hook is purely a UX accelerator that mirrors the same rules.
 *
 * Usage:
 * ```tsx
 * const gate = useEntitlementGate("payroll", "create");
 * if (!gate.allowed) {
 *   return <UpgradePrompt reason={gate.reason} action={gate.upgradeAction} />;
 * }
 * return <Button onClick={runPayroll}>Run Payroll</Button>;
 * ```
 *
 * Or, for inline disabling:
 * ```tsx
 * <Button disabled={!gate.allowed} title={gate.hint}>Run Payroll</Button>
 * ```
 */

import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useAppAccess } from "@/hooks/useAppAccess";
import { useInstalledApps } from "@/hooks/useInstalledApps";
import { useAppSetupStatus } from "@/hooks/useAppSetupStatus";
import { getAppById } from "@/lib/apps/registry";

export type EntitlementAction = "read" | "create" | "update" | "delete" | "approve" | "post" | "export";

export type EntitlementBlockReason =
  | "not_installed"
  | "not_in_plan"
  | "trial_expired"
  | "setup_incomplete"
  | "coming_soon"
  | "unknown_app";

export interface UpgradeAction {
  label: string;
  /** Where to send the user. Falls back to `/apps/{appId}/activate`. */
  href: string;
}

export interface EntitlementGateResult {
  /** True if the action can be attempted right now. */
  allowed: boolean;
  /** Coarse reason the action is blocked. `undefined` when allowed. */
  reason?: EntitlementBlockReason;
  /** Short human label suitable for a tooltip (`title=`). */
  hint?: string;
  /** Suggested CTA (Subscribe / Complete setup / Install). `undefined` when allowed. */
  upgradeAction?: UpgradeAction;
  /** Convenience navigator for the suggested CTA. */
  goToUpgrade: () => void;
  /** While caches are loading, prefer to keep buttons disabled. */
  isLoading: boolean;
}

const READ_ONLY_ACTIONS: EntitlementAction[] = ["read", "export"];

/**
 * Resolve whether a UI write action should be enabled for `appId`.
 *
 * Read/export actions are always allowed for installed apps regardless of
 * setup state — read-only views over historical data must remain accessible
 * (e.g. after a downgrade). Write actions require the full chain: app
 * installed + entitled + setup complete.
 */
export function useEntitlementGate(
  appId: string,
  action: EntitlementAction = "create",
): EntitlementGateResult {
  const navigate = useNavigate();
  // eslint-disable-next-line local/no-raw-installed-apps-loading-gate -- composite gate hook; isReady is enforced by useWorkspaceContextReady at the surface
  const { isInstalled, isLoading: installsLoading } = useInstalledApps();
  const { getAppEntitlementState, isLoading: accessLoading } = useAppAccess();
  const { getCardSummary } = useAppSetupStatus();

  return useMemo<EntitlementGateResult>(() => {
    const app = getAppById(appId);
    const goTo = (href: string) => () => navigate(href);
    const activatePath = `/apps/${appId}/activate`;

    if (!app) {
      return {
        allowed: false,
        reason: "unknown_app",
        hint: "Unknown app",
        goToUpgrade: goTo("/apps"),
        isLoading: false,
      };
    }

    if (installsLoading || accessLoading) {
      return {
        allowed: false,
        hint: "Checking access…",
        goToUpgrade: goTo(activatePath),
        isLoading: true,
      };
    }

    const state = getAppEntitlementState(appId);

    // Coming-soon apps short-circuit before anything else.
    if (state === "coming_soon" || app.comingSoon) {
      return {
        allowed: false,
        reason: "coming_soon",
        hint: `${app.name} is coming soon`,
        upgradeAction: { label: "Learn more", href: activatePath },
        goToUpgrade: goTo(activatePath),
        isLoading: false,
      };
    }

    const installed = isInstalled(appId);

    if (!installed) {
      return {
        allowed: false,
        reason: "not_installed",
        hint: `Install ${app.name} to ${action === "read" ? "view" : "use"} this`,
        upgradeAction: { label: `Install ${app.name}`, href: activatePath },
        goToUpgrade: goTo(activatePath),
        isLoading: false,
      };
    }

    if (state === "expired_trial") {
      return {
        allowed: false,
        reason: "trial_expired",
        hint: `${app.name} trial ended — subscribe to continue`,
        upgradeAction: { label: "Subscribe", href: "/settings/apps" },
        goToUpgrade: goTo("/settings/apps"),
        isLoading: false,
      };
    }

    // Read-only actions over installed-and-entitled apps are always allowed
    // (covers downgraded / read-only states preserving historical data).
    if (READ_ONLY_ACTIONS.includes(action)) {
      return { allowed: true, goToUpgrade: goTo(activatePath), isLoading: false };
    }

    // Write actions additionally require setup-completeness.
    const setup = getCardSummary(appId);
    if (setup && setup.isReady === false) {
      return {
        allowed: false,
        reason: "setup_incomplete",
        hint:
          setup.reasons && setup.reasons.length > 0
            ? `Setup required: ${setup.reasons.slice(0, 2).join(", ")}`
            : `Complete ${app.name} setup first`,
        upgradeAction: { label: "Complete setup", href: activatePath },
        goToUpgrade: goTo(activatePath),
        isLoading: false,
      };
    }

    return { allowed: true, goToUpgrade: goTo(activatePath), isLoading: false };
  }, [
    appId,
    action,
    installsLoading,
    accessLoading,
    isInstalled,
    getAppEntitlementState,
    getCardSummary,
    navigate,
  ]);
}
