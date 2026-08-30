/**
 * useActionGate Hook
 *
 * Single-institution model: there are no plans, trials or entitlements.
 * A write action is available when the app is installed for the institution
 * and its required setup is complete. RBAC (roles + permissions) decides
 * *who* may perform it and is enforced server-side; this hook is only a UX
 * accelerator so the user sees a setup prompt instead of a backend error.
 *
 * Usage:
 * ```tsx
 * const gate = useActionGate("loans", "create");
 * <Button disabled={!gate.allowed} title={gate.hint}>Disburse</Button>
 * ```
 */

import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useInstalledApps } from "@/hooks/useInstalledApps";
import { useAppSetupStatus } from "@/hooks/useAppSetupStatus";
import { getAppById } from "@/lib/apps/registry";

export type GateAction = "read" | "create" | "update" | "delete" | "approve" | "post" | "export";

export type GateBlockReason =
  | "not_installed"
  | "setup_incomplete"
  | "coming_soon"
  | "unknown_app";

export interface GateCta {
  label: string;
  /** Where to send the user. Falls back to `/apps/{appId}/activate`. */
  href: string;
}

export interface ActionGateResult {
  /** True if the action can be attempted right now. */
  allowed: boolean;
  /** Coarse reason the action is blocked. `undefined` when allowed. */
  reason?: GateBlockReason;
  /** Short human label suitable for a tooltip (`title=`). */
  hint?: string;
  /** Suggested CTA (Install / Complete setup). `undefined` when allowed. */
  cta?: GateCta;
  /** Convenience navigator for the suggested CTA. */
  goToCta: () => void;
  /** While caches are loading, prefer to keep buttons disabled. */
  isLoading: boolean;
}

const READ_ONLY_ACTIONS: GateAction[] = ["read", "export"];

export function useActionGate(appId: string, action: GateAction = "create"): ActionGateResult {
  const navigate = useNavigate();
  // eslint-disable-next-line local/no-raw-installed-apps-loading-gate -- composite gate hook; isReady is enforced by useWorkspaceContextReady at the surface
  const { isInstalled, isLoading: installsLoading } = useInstalledApps();
  const { getCardSummary } = useAppSetupStatus();

  return useMemo<ActionGateResult>(() => {
    const app = getAppById(appId);
    const goTo = (href: string) => () => navigate(href);
    const activatePath = `/apps/${appId}/activate`;

    if (!app) {
      return {
        allowed: false,
        reason: "unknown_app",
        hint: "Unknown app",
        goToCta: goTo("/apps"),
        isLoading: false,
      };
    }

    if (installsLoading) {
      return {
        allowed: false,
        hint: "Checking access…",
        goToCta: goTo(activatePath),
        isLoading: true,
      };
    }

    if (app.comingSoon) {
      return {
        allowed: false,
        reason: "coming_soon",
        hint: `${app.name} is coming soon`,
        cta: { label: "Learn more", href: activatePath },
        goToCta: goTo(activatePath),
        isLoading: false,
      };
    }

    if (!isInstalled(appId)) {
      return {
        allowed: false,
        reason: "not_installed",
        hint: `Install ${app.name} to ${action === "read" ? "view" : "use"} this`,
        cta: { label: `Install ${app.name}`, href: activatePath },
        goToCta: goTo(activatePath),
        isLoading: false,
      };
    }

    // Read/export over an installed app is always allowed — historical data
    // must stay reachable even when setup is incomplete.
    if (READ_ONLY_ACTIONS.includes(action)) {
      return { allowed: true, goToCta: goTo(activatePath), isLoading: false };
    }

    const setup = getCardSummary(appId);
    if (setup && setup.isReady === false) {
      return {
        allowed: false,
        reason: "setup_incomplete",
        hint:
          setup.reasons && setup.reasons.length > 0
            ? `Setup required: ${setup.reasons.slice(0, 2).join(", ")}`
            : `Complete ${app.name} setup first`,
        cta: { label: "Complete setup", href: activatePath },
        goToCta: goTo(activatePath),
        isLoading: false,
      };
    }

    return { allowed: true, goToCta: goTo(activatePath), isLoading: false };
  }, [appId, action, installsLoading, isInstalled, getCardSummary, navigate]);
}
