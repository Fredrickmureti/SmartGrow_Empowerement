/**
 * leaderProbe
 *
 * Cross-tab "is another tab actively provisioning a workspace right now?"
 * detector. Mirrors the storage layout written by `useOnboardingLeader` so
 * read-only consumers (RedirectIfAuthenticated, SelectOrganization) can
 * defer redirects while a sibling tab is mid-RPC.
 *
 * Why this exists
 * ---------------
 * Supabase auth broadcasts SIGNED_IN to every open tab. If tab B (the
 * verification-link tab) signs in before tab A (the original signup tab)
 * has called complete_onboarding, naive guards in tab A would route to
 * /select-organization → see 0 orgs → bounce to /onboarding-setup,
 * spawning a second wizard race. By probing for an active leader we can
 * hold tab A on a neutral screen until provisioning finishes.
 *
 * This module is deliberately pure (no React) so it can be called from
 * route guards, effects, or async resolvers.
 */
const STORAGE_PREFIX = "ls_onboarding_leader:";
/** A leader's heartbeat is considered fresh for this many ms. */
const LEADER_FRESHNESS_MS = 10_000;

interface LeaderRecord {
  tabId: string;
  ts: number;
}

/**
 * Returns true if any tab (this one or another) currently holds a fresh
 * leadership token for an in-flight onboarding saga.
 *
 * "Fresh" = heartbeat within LEADER_FRESHNESS_MS. Stale entries from a
 * crashed leader are ignored so we don't deadlock the UI.
 */
export function hasActiveOnboardingLeader(): boolean {
  if (typeof window === "undefined" || typeof localStorage === "undefined") {
    return false;
  }
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(STORAGE_PREFIX)) continue;
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as LeaderRecord;
        if (parsed && typeof parsed.ts === "number") {
          if (Date.now() - parsed.ts < LEADER_FRESHNESS_MS) {
            return true;
          }
        }
      } catch {
        /* malformed → ignore */
      }
    }
  } catch {
    /* localStorage unavailable */
  }
  return false;
}

/**
 * Convenience helper for guards: "should I delay my redirect to wait for
 * a sibling tab's provisioning to land?"
 */
export function shouldDeferForOnboardingLeader(): boolean {
  return hasActiveOnboardingLeader();
}
