/**
 * useCanSwitchScope — trigger visibility contract.
 *
 * Pins the Round-3 fix: create-only permissions must NOT flip
 * `shouldShowTrigger` on a single-target tenant. Settings owns the
 * "create company/branch" entry point, not the scope switcher.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";

const orgState = { organizations: [] as Array<{ id: string }> };
const bizState = { businesses: [] as Array<{ id: string }> };
const branchState = { branches: [] as Array<{ id: string }> };
const permState = {
  canManageOrganization: false as boolean,
  canManageBusiness: false as boolean,
};
const dashState = { isConsolidatedAuthorized: false as boolean };

vi.mock("@/hooks/useOrganization", () => ({
  useOrganization: () => orgState,
}));
vi.mock("@/contexts/BusinessContext", () => ({
  useBusinesses: () => bizState,
}));
vi.mock("@/contexts/BranchContext", () => ({
  useBranch: () => branchState,
}));
vi.mock("@/hooks/usePermissions", () => ({
  usePermissions: () => permState,
}));
vi.mock("@/hooks/useDashboardScope", () => ({
  useDashboardScope: () => dashState,
}));

import { useCanSwitchScope } from "@/hooks/useCanSwitchScope";

function set(opts: {
  orgs?: number;
  biz?: number;
  branches?: number;
  canManageOrg?: boolean;
  canManageBiz?: boolean;
  consolidatedAuthorized?: boolean;
}) {
  orgState.organizations = Array.from({ length: opts.orgs ?? 1 }, (_, i) => ({ id: `o${i}` }));
  bizState.businesses = Array.from({ length: opts.biz ?? 1 }, (_, i) => ({ id: `b${i}` }));
  branchState.branches = Array.from({ length: opts.branches ?? 1 }, (_, i) => ({ id: `br${i}` }));
  permState.canManageOrganization = !!opts.canManageOrg;
  permState.canManageBusiness = !!opts.canManageBiz;
  dashState.isConsolidatedAuthorized = !!opts.consolidatedAuthorized;
}

describe("useCanSwitchScope", () => {
  beforeEach(() => set({}));

  it("single-target admin: hides the trigger but flags the create hint", () => {
    set({ canManageOrg: true, canManageBiz: true });
    const { result } = renderHook(() => useCanSwitchScope());
    expect(result.current.shouldShowTrigger).toBe(false);
    expect(result.current.shouldShowCreateHint).toBe(true);
  });

  it("single-target non-admin: hides both", () => {
    set({});
    const { result } = renderHook(() => useCanSwitchScope());
    expect(result.current.shouldShowTrigger).toBe(false);
    expect(result.current.shouldShowCreateHint).toBe(false);
  });

  it("multi-branch: trigger shows regardless of create perms", () => {
    set({ branches: 2 });
    const { result } = renderHook(() => useCanSwitchScope());
    expect(result.current.shouldShowTrigger).toBe(true);
    expect(result.current.shouldShowCreateHint).toBe(false);
  });

  it("multi-company: trigger shows", () => {
    set({ biz: 2 });
    expect(renderHook(() => useCanSwitchScope()).result.current.shouldShowTrigger).toBe(true);
  });

  it("multi-workspace: trigger shows", () => {
    set({ orgs: 2 });
    expect(renderHook(() => useCanSwitchScope()).result.current.shouldShowTrigger).toBe(true);
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
