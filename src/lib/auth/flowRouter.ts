/**
 * flowRouter
 *
 * Single source of truth for "given an authenticated user and what we know
 * about their workspace, where should they be right now?".
 *
 * This complements `resolvePostLoginDestination` (which is async + needs DB
 * round-trips for platform-admin detection) with a synchronous resolver
 * that takes already-loaded session state. Used by route-level guards
 * (SubscriptionProtectedRoute, OnboardingSetup, SelectOrganization) so
 * every "where do I send this user?" decision goes through one function
 * instead of being scattered across components.
 */
import type { User } from "@supabase/supabase-js";

export interface FlowState {
  user: User | null;
  /** True if AuthContext has finished its initial session restore. */
  authResolved: boolean;
  /** True if SessionContext has finished its initial RPC. */
  sessionResolved: boolean;
  /** Number of organization memberships visible to this user. */
  organizationCount: number;
  /** Whether the user is a platform admin. */
  isPlatformAdmin: boolean;
  /** Whether is_vendor_portal flag is set on user_metadata. */
  isVendorPortal: boolean;
  /** Whether onboarding_completed flag is set on user_metadata. */
  onboardingCompleted: boolean;
  /** Whether the email is confirmed. */
  emailConfirmed: boolean;
  /** Optional return-to path captured before auth. */
  intendedPath?: string | null;
}

export type FlowDestination =
  | { kind: "stay" }
  | { kind: "loading"; reason: "auth" | "session" }
  | { kind: "redirect"; to: string; reason: string };

export function resolveFlow(state: FlowState): FlowDestination {
  if (!state.authResolved) return { kind: "loading", reason: "auth" };

  // Unauthenticated → login
  if (!state.user) {
    return { kind: "redirect", to: "/login", reason: "no-user" };
  }

  // Email not yet confirmed → /verify-email
  if (!state.emailConfirmed) {
    return { kind: "redirect", to: "/verify-email", reason: "email-unconfirmed" };
  }

  // Vendor portal short-circuit
  if (state.isVendorPortal) {
    return { kind: "redirect", to: "/vendor-portal", reason: "vendor" };
  }

  // Platform admin short-circuit (don't push them through customer onboarding)
  if (state.isPlatformAdmin) {
    return { kind: "redirect", to: "/admin-management", reason: "platform-admin" };
  }

  if (!state.sessionResolved) return { kind: "loading", reason: "session" };

  // No memberships and onboarding not completed → onboarding wizard
  if (state.organizationCount === 0 && !state.onboardingCompleted) {
    return { kind: "redirect", to: "/onboarding-setup", reason: "onboarding-incomplete" };
  }

  // No memberships but onboarding flag is set → user lost access; surface
  // the empty state on /select-organization rather than re-entering wizard.
  if (state.organizationCount === 0 && state.onboardingCompleted) {
    return { kind: "redirect", to: "/select-organization", reason: "no-orgs-but-completed" };
  }

  // Multiple memberships → let the user choose, but ONLY when we don't
  // already know where they were going. If we have an `intendedPath` (the
  // URL they reloaded on, or the route they were deep-linking to), honor
  // it directly — the session already has a selected org from localStorage,
  // and forcing the picker here is what made every reload feel like a
  // workspace reset.
  if (state.organizationCount > 1 && !state.intendedPath) {
    return { kind: "redirect", to: "/select-organization", reason: "multi-org" };
  }

  // Single membership, or multi-org with an intended path → honor it.
  const dest =
    state.intendedPath && isSafeRedirect(state.intendedPath)
      ? state.intendedPath
      : "/home";
  return { kind: "redirect", to: dest, reason: "ready" };
}

function isSafeRedirect(path: string): boolean {
  return typeof path === "string" && path.startsWith("/") && !path.startsWith("//");
}
