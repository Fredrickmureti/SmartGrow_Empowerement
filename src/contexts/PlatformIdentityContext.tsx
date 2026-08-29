/**
 * PlatformIdentityContext — retired persona.
 *
 * The SaaS "platform admin" (operator of a multi-tenant product) does not
 * exist in the microfinance deployment: there is one institution, and its
 * highest role is the Super Administrator held in `user_roles`.
 *
 * The context is kept as a constant so the remaining call sites compile and
 * take their non-admin branch. New code must not read it.
 */
import type { ReactNode } from "react";
import type { PlatformAdminRole } from "@/hooks/usePlatformPermissions";

interface PlatformIdentityValue {
  isPlatformAdmin: boolean;
  platformRole: PlatformAdminRole | null;
  isChecking: boolean;
  refresh: () => Promise<void>;
}

const NOT_A_PLATFORM_ADMIN: PlatformIdentityValue = {
  isPlatformAdmin: false,
  platformRole: null,
  isChecking: false,
  refresh: async () => {},
};

/** @deprecated No-op passthrough; the persona was removed. */
export function PlatformIdentityProvider({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

/** @deprecated Always reports "not a platform admin". */
export function usePlatformIdentity(): PlatformIdentityValue {
  return NOT_A_PLATFORM_ADMIN;
}
