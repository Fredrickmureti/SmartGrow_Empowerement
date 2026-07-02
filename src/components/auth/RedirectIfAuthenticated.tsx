/**
 * RedirectIfAuthenticated
 *
 * Wraps any auth/public-only page (login, signup, admin login, forgot
 * password) and bounces an already-authenticated user to where they belong:
 *   - vendor portal users  → /vendor-portal
 *   - platform admins      → /admin-management
 *   - onboarded tenants    → /dashboard (or intended `?redirect=` if safe)
 *   - not-yet-onboarded    → /onboarding-setup
 *
 * Big systems (Xero, Notion, Odoo SaaS) never let an authenticated user
 * see a "sign in" form. This eliminates the flaw where visiting /login
 * while already logged in shows the form.
 *
 * Honors `?redirect=` query param and router state `from` for deep-link
 * recovery after login.
 */
import { ReactNode, useEffect, useState } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { resolvePostLoginDestination } from "@/lib/auth/postLoginRedirect";
import { BrandedLoader } from "@/components/common/BrandedLoader";
import { shouldDeferForOnboardingLeader } from "@/lib/onboarding/leaderProbe";

interface RedirectIfAuthenticatedProps {
  children: ReactNode;
  /**
   * If true, this is the password-recovery page — do NOT redirect when the
   * URL hash carries a recovery token (Supabase puts the user into a
   * temporary session to let them set a new password).
   */
  allowRecoveryHash?: boolean;
}

function hasRecoveryHash(): boolean {
  if (typeof window === "undefined") return false;
  const hash = window.location.hash || "";
  return hash.includes("type=recovery");
}

export function RedirectIfAuthenticated({
  children,
  allowRecoveryHash = false,
}: RedirectIfAuthenticatedProps) {
  const { user, isLoading } = useAuth();
  const location = useLocation();
  const [destination, setDestination] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);

  // Read intended path from ?redirect= or router state.from (set by
  // ProtectedRoute when bouncing an unauthenticated user to /login).
  const intendedPath = (() => {
    try {
      const fromQuery = new URLSearchParams(location.search).get("redirect");
      if (fromQuery && fromQuery.startsWith("/") && !fromQuery.startsWith("//")) {
        return fromQuery;
      }
    } catch {
      /* ignore */
    }
    const stateFrom = (location.state as { from?: { pathname?: string } } | null)
      ?.from?.pathname;
    if (stateFrom && typeof stateFrom === "string" && stateFrom.startsWith("/")) {
      return stateFrom;
    }
    return null;
  })();

  // Sibling-tab probe: if another tab is mid-onboarding RPC, hold here on
  // a neutral loader instead of racing to /select-organization (which sees
  // 0 orgs and bounces to /onboarding-setup, doubling the wizard).
  // Re-checks on a short interval so we resume the moment the leader tab
  // finishes (its heartbeat goes stale or it broadcasts release).
  const [deferForLeader, setDeferForLeader] = useState<boolean>(() =>
    shouldDeferForOnboardingLeader(),
  );
  useEffect(() => {
    if (!user) {
      setDeferForLeader(false);
      return;
    }
    setDeferForLeader(shouldDeferForOnboardingLeader());
    const id = window.setInterval(() => {
      setDeferForLeader(shouldDeferForOnboardingLeader());
    }, 750);
    return () => clearInterval(id);
  }, [user]);

  useEffect(() => {
    let cancelled = false;
    if (isLoading) return;
    if (!user) {
      setDestination(null);
      return;
    }
    // On the password-reset page with a recovery hash, don't redirect — the
    // user needs to stay here to set their new password.
    if (allowRecoveryHash && hasRecoveryHash()) {
      setDestination(null);
      return;
    }
    // Wait out a sibling tab's onboarding RPC before resolving destination.
    if (deferForLeader) {
      return;
    }
    setResolving(true);
    resolvePostLoginDestination({ user, intendedPath })
      .then((dest) => {
        if (!cancelled) setDestination(dest);
      })
      .finally(() => {
        if (!cancelled) setResolving(false);
      });
    return () => {
      cancelled = true;
    };
  }, [user, isLoading, intendedPath, allowRecoveryHash, deferForLeader]);

  if (isLoading || (user && deferForLeader && !destination)) {
    return <BrandedLoader message="Finishing setup in another tab..." />;
  }
  if (user && resolving && !destination) {
    return <BrandedLoader message="Checking your session..." />;
  }

  if (user && destination) {
    return <Navigate to={destination} replace />;
  }

  return <>{children}</>;
}
