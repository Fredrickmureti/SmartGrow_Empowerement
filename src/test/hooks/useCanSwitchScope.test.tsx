/**
 * useCanSwitchScope — trigger visibility contract (single institution).
 *
 * The institution (workspace + company) is a fixed configuration root, so
 * only branch count and the consolidated reporting view can produce an
 * alternative scope. Creating workspaces/companies is not a product
 * capability any more, so the create hint is always false.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";

const branchState = { branches: [] as Array<{ id: string }> };
const dashState = { isConsolidatedAuthorized: false as boolean };

vi.mock("@/contexts/BranchContext", () => ({
  useBranch: () => branchState,
}));
vi.mock("@/hooks/useDashboardScope", () => ({
  useDashboardScope: () => dashState,
}));

import { useCanSwitchScope } from "@/hooks/useCanSwitchScope";

function set(opts: { branches?: number; consolidatedAuthorized?: boolean }) {
  branchState.branches = Array.from({ length: opts.branches ?? 1 }, (_, i) => ({ id: `br${i}` }));
  dashState.isConsolidatedAuthorized = !!opts.consolidatedAuthorized;
}

describe("useCanSwitchScope", () => {
  beforeEach(() => set({}));

  it("single branch: hides the trigger and never offers a create hint", () => {
    const { result } = renderHook(() => useCanSwitchScope());
    expect(result.current.shouldShowTrigger).toBe(false);
    expect(result.current.shouldShowCreateHint).toBe(false);
    expect(result.current.canCreateAny).toBe(false);
  });

  it("multi-branch: trigger shows", () => {
    set({ branches: 2 });
    const { result } = renderHook(() => useCanSwitchScope());
    expect(result.current.shouldShowTrigger).toBe(true);
    expect(result.current.shouldShowCreateHint).toBe(false);
  });

  it("single-branch + consolidated-authorized: trigger hidden (nothing to consolidate across)", () => {
    set({ branches: 1, consolidatedAuthorized: true });
    const { result } = renderHook(() => useCanSwitchScope());
    expect(result.current.shouldShowTrigger).toBe(false);
    expect(result.current.canSwitchToConsolidated).toBe(false);
  });

  it("multi-branch + consolidated-authorized: trigger shows and canSwitchToConsolidated true", () => {
    set({ branches: 2, consolidatedAuthorized: true });
    const { result } = renderHook(() => useCanSwitchScope());
    expect(result.current.shouldShowTrigger).toBe(true);
    expect(result.current.canSwitchToConsolidated).toBe(true);
  });
});
