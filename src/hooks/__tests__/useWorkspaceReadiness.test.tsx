/**
 * Tests for useWorkspaceReadiness.
 *
 * Focus: the readiness predicate's contract — it must wait for both an
 * organization AND (when requireBusiness is true) a company before going
 * `ready`. This was Defect 3 in the plan: navigating /home with an org
 * but no company landed users on a forever-spinner.
 *
 * We test the predicate in isolation by stubbing the contexts the hook
 * consumes. The stale-metadata-recovery scenario lives in the integration
 * suite (`OnboardingSetup` end-to-end) — here we lock down the unit
 * behavior so future refactors can't silently regress it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import React from "react";

// Hoisted mocks: vitest hoists vi.mock above imports.
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    channel: () => ({
      on: () => ({ subscribe: () => ({}) }),
    }),
    removeChannel: () => {},
  },
}));

const refreshSession = vi.fn(async () => {});
const refreshBusinesses = vi.fn(async () => {});

let sessionState: any = {
  sessionData: null,
  currentOrg: null,
  refreshSession,
};
let businessState: any = {
  currentBusiness: null,
  businesses: [],
  isLoading: false,
  refreshBusinesses,
};

vi.mock("@/contexts/SessionContext", () => ({
  useSession: () => sessionState,
}));
vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({ user: { id: "user-1" } }),
}));
vi.mock("@/contexts/BusinessContext", () => ({
  useBusinesses: () => businessState,
}));

import { useWorkspaceReadiness } from "../useWorkspaceReadiness";

describe("useWorkspaceReadiness", () => {
  beforeEach(() => {
    refreshSession.mockClear();
    refreshBusinesses.mockClear();
    sessionState = {
      sessionData: null,
      currentOrg: null,
      refreshSession,
    };
    businessState = {
      currentBusiness: null,
      businesses: [],
      isLoading: false,
      refreshBusinesses,
    };
  });

  it("starts idle when not enabled", () => {
    const { result } = renderHook(() =>
      useWorkspaceReadiness({ enabled: false }),
    );
    expect(result.current.state).toBe("idle");
  });

  it("does NOT report ready when org exists but no business yet", async () => {
    sessionState = {
      sessionData: { organizations: [{ id: "o1" }] },
      currentOrg: { id: "o1" },
      refreshSession,
    };
    // BusinessContext still loading — predicate must wait.
    businessState = {
      currentBusiness: null,
      businesses: [],
      isLoading: true,
      refreshBusinesses,
    };

    const { result } = renderHook(() =>
      useWorkspaceReadiness({ enabled: true, timeoutMs: 5_000 }),
    );
    expect(result.current.state).toBe("loading");
  });

  it("reports ready when org and business are both available", async () => {
    sessionState = {
      sessionData: { organizations: [{ id: "o1" }] },
      currentOrg: { id: "o1" },
      refreshSession,
    };
    businessState = {
      currentBusiness: { id: "b1" },
      businesses: [{ id: "b1" }],
      isLoading: false,
      refreshBusinesses,
    };

    const { result } = renderHook(() =>
      useWorkspaceReadiness({ enabled: true, timeoutMs: 5_000 }),
    );
    await waitFor(() => expect(result.current.state).toBe("ready"));
  });

  it("respects requireBusiness=false (org alone is enough)", async () => {
    sessionState = {
      sessionData: { organizations: [{ id: "o1" }] },
      currentOrg: { id: "o1" },
      refreshSession,
    };
    businessState = {
      currentBusiness: null,
      businesses: [],
      isLoading: true,
      refreshBusinesses,
    };

    const { result } = renderHook(() =>
      useWorkspaceReadiness({
        enabled: true,
        timeoutMs: 5_000,
        requireBusiness: false,
      }),
    );
    await waitFor(() => expect(result.current.state).toBe("ready"));
  });

  it("transitions to timed_out after the timeout elapses", async () => {
    sessionState = {
      sessionData: { organizations: [] },
      currentOrg: null,
      refreshSession,
    };
    const { result } = renderHook(() =>
      useWorkspaceReadiness({ enabled: true, timeoutMs: 200 }),
    );
    expect(result.current.state).toBe("loading");
    await waitFor(
      () => expect(result.current.state).toBe("timed_out"),
      { timeout: 2_000 },
    );
  });
});
