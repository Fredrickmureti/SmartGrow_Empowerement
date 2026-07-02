import { ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { OnboardingGuard } from "./OnboardingGuard";

/**
 * OnboardingGate
 *
 * Mounted once inside the Router. For routes that require an authenticated,
 * onboarded user, it delegates to <OnboardingGuard>. For public/auth routes
 * (login, signup, verify-email, onboarding-setup itself, password reset,
 * accept-invitation, vendor-portal accept, public sign/spreadsheet links,
 * landing, marketing pages), it renders children unguarded.
 *
 * This eliminates the need to wrap every authenticated <Route> manually and
 * avoids the previous bug where an already-onboarded user could land on
 * /onboarding-setup and re-trigger the workspace-creation flow.
 */
const PUBLIC_PATH_PREFIXES = [
  "/login",
  "/signup",
  "/verify-email",
  "/onboarding-setup",
  "/auth/callback",
  "/forgot-password",
  "/reset-password",
  "/accept-invitation",
  "/vendor-portal/accept",
  "/sign/s/",
  "/spreadsheets/s/",
  "/admin-management/login",
  "/admin-management/mfa-setup",
  // Belt-and-braces: admins are already short-circuited inside
  // OnboardingGuard via the platform-identity context, but listing the
  // entire admin namespace as public ensures the onboarding wizard cannot
  // briefly render for a platform admin during the persona probe.
  "/admin-management",
  "/admin-management/accept-invitation",
  "/help",
  "/docs",
  "/about",
  "/blog",
  "/features",
  "/contact",
  "/install",
  "/privacy",
  "/terms",
  "/cookies",
  "/demo",
];

const PUBLIC_EXACT_PATHS = new Set<string>(["/"]);

export function OnboardingGate({ children }: { children: ReactNode }) {
  const location = useLocation();
  const path = location.pathname;

  const isPublic =
    PUBLIC_EXACT_PATHS.has(path) ||
    PUBLIC_PATH_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix + "/"));

  if (isPublic) {
    return <>{children}</>;
  }

  return <OnboardingGuard>{children}</OnboardingGuard>;
}
