import { describe, it, expect, beforeEach, vi } from "vitest";
import { authExpiryCoordinator } from "@/services/resilience/AuthExpiryCoordinator";
import { normalizeError } from "@/services/resilience/ErrorNormalizer";

describe("AuthExpiryCoordinator", () => {
  beforeEach(() => authExpiryCoordinator._resetForTests());

  it("fires once per suppression window even on N concurrent 401s", () => {
    const notify = vi.fn();
    const signOut = vi.fn(async () => {});
    const redirect = vi.fn();
    authExpiryCoordinator.configure({ notify, signOut, redirect });

    for (let i = 0; i < 20; i++) {
      normalizeError({ status: 401, message: "jwt expired" });
    }

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0].title).toBe("Session expired");
  });

  it("does nothing when unconfigured", () => {
    expect(() => normalizeError({ status: 401 })).not.toThrow();
  });
});
