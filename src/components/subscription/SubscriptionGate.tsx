import type { ReactNode } from "react";

/**
 * Single-institution deployment: there are no subscription plans, so every
 * feature gate is open. These shims keep legacy call sites compiling until
 * they are migrated away.
 */
export const featureLabels: Record<string, string> = {};

export function SubscriptionGate({ children }: { children: ReactNode; feature?: string; fallback?: ReactNode }) {
  return <>{children}</>;
}

export function SubscriptionFeatureCheck({ children }: { children: ReactNode; feature?: string }) {
  return <>{children}</>;
}
