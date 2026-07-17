/**
 * CapabilityGate — declarative wrapper for capability-gated UI.
 *
 * Usage:
 *   <CapabilityGate cap="projects.analytic-tagging">
 *     <ProjectPicker ... />
 *   </CapabilityGate>
 *
 * Rendering rules (see `useCapability` for the contract):
 *   - hydrating       → render `pendingFallback` (default: nothing)
 *   - not available   → render `fallback` (default: nothing)
 *   - available       → render children
 *
 * When the providing app is uninstalled, the wrapped subtree is
 * unmounted and never asks the user for input tied to that app. This
 * is the single place we degrade cross-app integrations.
 */
import type { ReactNode } from "react";
import { useCapability } from "@/hooks/useCapability";
import type { Capability } from "@/lib/apps/capabilities";

interface CapabilityGateProps {
  cap: Capability;
  children: ReactNode;
  /** Rendered when the providing app is not installed. Default: null. */
  fallback?: ReactNode;
  /** Rendered while workspace readiness is still hydrating. Default: null. */
  pendingFallback?: ReactNode;
}

export function CapabilityGate({
  cap,
  children,
  fallback = null,
  pendingFallback = null,
}: CapabilityGateProps) {
  const { available, ready } = useCapability(cap);
  if (!ready) return <>{pendingFallback}</>;
  if (!available) return <>{fallback}</>;
  return <>{children}</>;
}
