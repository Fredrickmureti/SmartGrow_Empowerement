/**
 * useCapability — runtime resolver for cross-app integration points.
 *
 * Returns `{ available, ready }`:
 *   - `ready === false`  → workspace readiness is still hydrating. Do NOT
 *                          paint UI that changes on the answer; render a
 *                          skeleton or nothing.
 *   - `available === true` → the providing app is installed for the
 *                            current org AND readiness is authoritative.
 *   - `available === false` (with ready) → the providing app is not
 *                            installed. Consumer must degrade gracefully:
 *                            hide the field, submit with null, etc.
 *
 * This is deliberately the ONLY entry point for cross-app UI decisions.
 * A widget owned by app A that appears inside app B must self-gate on
 * `useCapability(cap)` — the consumer should not need to know which app
 * provides `cap`.
 */
import { useInstalledApps } from "@/hooks/useInstalledApps";
import { useWorkspaceContextReady } from "@/hooks/useWorkspaceContextReady";
import { CAPABILITY_PROVIDERS, type Capability } from "@/lib/apps/capabilities";

export interface UseCapabilityResult {
  available: boolean;
  ready: boolean;
}

export function useCapability(cap: Capability): UseCapabilityResult {
  const providerAppId = CAPABILITY_PROVIDERS[cap];
  const { isInstalled } = useInstalledApps();
  const { ready } = useWorkspaceContextReady({ appId: providerAppId });

  if (!ready) return { available: false, ready: false };
  if (!providerAppId) return { available: false, ready: true };
  return { available: isInstalled(providerAppId), ready: true };
}
