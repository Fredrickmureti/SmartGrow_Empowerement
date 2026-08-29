import type { ReactNode } from "react";

/**
 * Single-institution deployment: there is no app marketplace or per-org
 * installation state, so every module is always available. Kept as a
 * pass-through shim while legacy call sites are migrated away.
 */
export function AppInstalledGate({ children }: { children: ReactNode; appId?: string }) {
  return <>{children}</>;
}
