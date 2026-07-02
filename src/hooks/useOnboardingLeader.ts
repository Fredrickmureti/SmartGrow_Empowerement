/**
 * useOnboardingLeader
 *
 * Multi-tab coordination for the post-signup workspace-provisioning saga.
 *
 * Problem this solves
 * -------------------
 * supabase.auth broadcasts SIGNED_IN to every tab the user has open. If the
 * user clicks the email-confirmation link in tab B while tab A is still on
 * /signup, BOTH tabs would race to land on /onboarding-setup and both would
 * try to call complete_onboarding(). The second one collides on the
 * idempotency key (best case) or on slug uniqueness / org membership (worst
 * case), and the user sees a flash of "workspace already exists" or two
 * spinners that never resolve.
 *
 * Strategy
 * --------
 *   - Acquire a leadership token in sessionStorage keyed by the user's
 *     idempotency key. The first tab to write wins.
 *   - Announce the win on a BroadcastChannel so other tabs immediately
 *     downgrade to "follower" mode (= just observe session, never call the
 *     RPC).
 *   - On unload / signout, release the token so the next tab can take over
 *     if the leader crashed mid-flow.
 *   - Followers periodically check the channel and the storage flag; if no
 *     leader announces within a grace window they self-promote (recovery
 *     for the case where the leader tab was closed before the RPC fired).
 *
 * This is the same pattern Slack and Linear use to coordinate "only one tab
 * should run the heavy bootstrapping job" while still letting every tab
 * react to the result.
 */
import { useEffect, useRef, useState } from "react";

type Role = "pending" | "leader" | "follower";

interface UseOnboardingLeaderOptions {
  /** Stable per-saga key. Same key across tabs ⇒ same election. */
  idempotencyKey: string | null | undefined;
  /** Disable election entirely (e.g. before auth resolves). */
  enabled?: boolean;
  /** ms to wait for an existing leader to announce before self-promoting. */
  followerGraceMs?: number;
}

const STORAGE_PREFIX = "onboarding_leader:";
const CHANNEL_NAME = "onboarding-leader";

interface ChannelMessage {
  type: "announce" | "release" | "completed" | "failed";
  key: string;
  tabId: string;
  payload?: Record<string, unknown>;
}

function getTabId(): string {
  if (typeof window === "undefined") return "ssr";
  const existing = sessionStorage.getItem("__tab_id");
  if (existing) return existing;
  const id = `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    sessionStorage.setItem("__tab_id", id);
  } catch {
    /* ignore */
  }
  return id;
}

export function useOnboardingLeader({
  idempotencyKey,
  enabled = true,
  followerGraceMs = 1500,
}: UseOnboardingLeaderOptions): {
  role: Role;
  isLeader: boolean;
  isFollower: boolean;
  /** Broadcast a "completed" signal to wake follower tabs to refresh. */
  announceCompleted: (payload?: Record<string, unknown>) => void;
  announceFailed: (reason: string) => void;
} {
  const [role, setRole] = useState<Role>("pending");
  const channelRef = useRef<BroadcastChannel | null>(null);
  const tabIdRef = useRef<string>(getTabId());
  const releasedRef = useRef(false);

  useEffect(() => {
    if (!enabled || !idempotencyKey || typeof window === "undefined") {
      setRole("pending");
      return;
    }

    const storageKey = STORAGE_PREFIX + idempotencyKey;
    const tabId = tabIdRef.current;
    let channel: BroadcastChannel | null = null;
    let promotionTimer: number | null = null;

    try {
      channel = new BroadcastChannel(CHANNEL_NAME);
      channelRef.current = channel;
    } catch {
      // BroadcastChannel unavailable (very old Safari). Fall back to
      // single-tab mode: act as leader, no coordination.
      setRole("leader");
      return;
    }

    const tryAcquire = (): boolean => {
      const existing = sessionStorage.getItem(storageKey);
      // sessionStorage is per-tab, so existing will be null in a fresh tab.
      // We use localStorage for cross-tab coordination instead.
      const lsKey = "ls_" + storageKey;
      const lsExisting = localStorage.getItem(lsKey);
      if (lsExisting && lsExisting !== tabId) {
        // Verify the leader is still alive: leaders refresh their heartbeat
        // every ~5s. If older than 15s, treat as crashed and steal.
        try {
          const parsed = JSON.parse(lsExisting) as { tabId: string; ts: number };
          if (Date.now() - parsed.ts < 15_000) {
            return false;
          }
        } catch {
          /* malformed → steal */
        }
      }
      try {
        localStorage.setItem(lsKey, JSON.stringify({ tabId, ts: Date.now() }));
        sessionStorage.setItem(storageKey, tabId);
      } catch {
        return false;
      }
      return true;
    };

    const becomeLeader = () => {
      if (releasedRef.current) return;
      setRole("leader");
      // Announce + start heartbeat
      channel?.postMessage({ type: "announce", key: idempotencyKey, tabId } as ChannelMessage);
    };

    const becomeFollower = () => {
      if (releasedRef.current) return;
      setRole("follower");
    };

    // Listen first so we don't miss an announce racing with our own attempt.
    channel.onmessage = (ev: MessageEvent<ChannelMessage>) => {
      const msg = ev.data;
      if (!msg || msg.key !== idempotencyKey) return;
      if (msg.tabId === tabId) return;
      if (msg.type === "announce") {
        if (promotionTimer) {
          clearTimeout(promotionTimer);
          promotionTimer = null;
        }
        becomeFollower();
      }
      if (msg.type === "release" || msg.type === "failed") {
        // Leader gave up — try to take over.
        if (tryAcquire()) becomeLeader();
      }
      if (msg.type === "completed") {
        // Stay follower — caller's effect will refresh session and route.
        becomeFollower();
      }
    };

    if (tryAcquire()) {
      becomeLeader();
    } else {
      becomeFollower();
      // Self-promote if no announce arrives in the grace window. This
      // recovers from "leader tab closed before announcing" edge cases.
      promotionTimer = window.setTimeout(() => {
        if (tryAcquire()) becomeLeader();
      }, followerGraceMs);
    }

    // Heartbeat so a long-running leader keeps its claim fresh.
    const heartbeat = window.setInterval(() => {
      if (releasedRef.current) return;
      const lsKey = "ls_" + storageKey;
      try {
        const cur = localStorage.getItem(lsKey);
        if (!cur) return;
        const parsed = JSON.parse(cur) as { tabId: string };
        if (parsed.tabId === tabId) {
          localStorage.setItem(lsKey, JSON.stringify({ tabId, ts: Date.now() }));
        }
      } catch {
        /* ignore */
      }
    }, 5_000);

    const release = () => {
      if (releasedRef.current) return;
      releasedRef.current = true;
      const lsKey = "ls_" + storageKey;
      try {
        const cur = localStorage.getItem(lsKey);
        if (cur) {
          const parsed = JSON.parse(cur) as { tabId: string };
          if (parsed.tabId === tabId) {
            localStorage.removeItem(lsKey);
          }
        }
        sessionStorage.removeItem(storageKey);
      } catch {
        /* ignore */
      }
      channel?.postMessage({ type: "release", key: idempotencyKey, tabId } as ChannelMessage);
    };

    window.addEventListener("beforeunload", release);

    return () => {
      if (promotionTimer) clearTimeout(promotionTimer);
      clearInterval(heartbeat);
      window.removeEventListener("beforeunload", release);
      release();
      channel?.close();
      channelRef.current = null;
    };
  }, [enabled, idempotencyKey, followerGraceMs]);

  const announceCompleted = (payload?: Record<string, unknown>) => {
    if (!idempotencyKey) return;
    channelRef.current?.postMessage({
      type: "completed",
      key: idempotencyKey,
      tabId: tabIdRef.current,
      payload,
    } as ChannelMessage);
  };

  const announceFailed = (reason: string) => {
    if (!idempotencyKey) return;
    channelRef.current?.postMessage({
      type: "failed",
      key: idempotencyKey,
      tabId: tabIdRef.current,
      payload: { reason },
    } as ChannelMessage);
  };

  return {
    role,
    isLeader: role === "leader",
    isFollower: role === "follower",
    announceCompleted,
    announceFailed,
  };
}
