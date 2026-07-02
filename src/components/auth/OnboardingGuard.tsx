import { useNavigate } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { useEffect } from "react";
import { NoWorkspaceEmptyState } from "@/components/common/NoWorkspaceEmptyState";
import { SessionFailureCard } from "@/components/common/SessionFailureCard";
import { useWorkspaceRouting } from "@/hooks/useWorkspaceRouting";

interface OnboardingGuardProps {
  children: React.ReactNode;
}

/**
 * OnboardingGuard — thin renderer over `useWorkspaceRouting`.
 *
 * All "which state are we in?" logic lives in the selector (one place,
 * one set of tests). This component only chooses what to render:
 *   - loading          → branded loader
 *   - error            → SessionFailureCard (retry / sign out)
 *   - needs-onboarding → navigate ONCE to /onboarding-setup (real intent,
 *                        not loading bookkeeping)
 *   - no-orgs          → empty state IN PLACE (URL never rewritten)
 *   - everything else  → children
 *
 * Platform admins and vendor-portal users are exempt: this guard renders
 * children for them and lets their own subtree gates take over.
 */
export function OnboardingGuard({ children }: OnboardingGuardProps) {
  const routing = useWorkspaceRouting();
  const navigate = useNavigate();

  useEffect(() => {
    if (routing.status !== "needs-onboarding") return;
    const onboardingPaths = [
      "/onboarding-setup",
      "/verify-email",
      "/signup",
      "/login",
    ];
    const currentPath = window.location.pathname;
    const onAllowedPath = onboardingPaths.some((p) => currentPath.startsWith(p));
    if (!onAllowedPath) navigate("/onboarding-setup", { replace: true });
  }, [routing.status, navigate]);

  if (routing.status === "loading") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  // Hard session-bootstrap failure: server didn't return a usable payload
  // even after retries. Surface an explicit failure card — never rewrite
  // the URL and never show "no workspace" (which would be a lie).
  if (routing.status === "error") {
    return <SessionFailureCard error={routing.error} />;
  }

  // Already-onboarded user who currently belongs to zero workspaces
  // (e.g. admin removed them). Empty state in place — never write
  // /select-organization into the URL.
  if (routing.status === "no-orgs") {
    return <NoWorkspaceEmptyState onboardingCompleted />;
  }

  // unauthenticated / platform-admin / vendor-portal / ready /
  // needs-onboarding (effect handles the navigate) all fall through to
  // children. Their own gates (login redirect, admin subtree, vendor
  // subtree) take over from here.
  return <>{children}</>;
}
