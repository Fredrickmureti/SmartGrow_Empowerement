/**
 * Guard: the identity outcome taxonomy is the single source of operator
 * copy for a failed resolution, and it never leaks infrastructure detail.
 */
import { describe, it, expect } from "vitest";
import {
  IDENTITY_STATUSES,
  describeIdentityOutcome,
} from "@/features/products/identity/identityOutcome";

describe("identity outcome taxonomy", () => {
  it("covers every status with copy and a remediation", () => {
    for (const status of IDENTITY_STATUSES) {
      const c = describeIdentityOutcome({ status, code: "5901234123457" });
      expect(c.title.length).toBeGreaterThan(0);
      expect(c.detail.length).toBeGreaterThan(0);
      expect(c.remediation.action).toBeTruthy();
    }
  });

  it("blocks every non-resolved outcome", () => {
    for (const status of IDENTITY_STATUSES) {
      const c = describeIdentityOutcome({ status, code: "ABC" });
      expect(c.blocking).toBe(status !== "resolved");
    }
  });

  it("never surfaces infrastructure detail to the operator", () => {
    const banned = /PGRST|SQLSTATE|rpc|supabase|postgres|null|undefined/i;
    for (const status of IDENTITY_STATUSES) {
      const c = describeIdentityOutcome({ status, code: "ABC" });
      expect(banned.test(`${c.title} ${c.detail}`)).toBe(false);
    }
  });

  it("distinguishes a retired code from an unknown one", () => {
    const archived = describeIdentityOutcome({ status: "archived", code: "OLD-1" });
    const unknown = describeIdentityOutcome({ status: "not_found", code: "OLD-1" });
    expect(archived.detail).not.toBe(unknown.detail);
    expect(archived.remediation.action).toBe("reactivate");
    expect(unknown.remediation.action).toBe("enrol");
  });

  it("reports the duplicate count on an ambiguous code", () => {
    const c = describeIdentityOutcome({ status: "ambiguous", code: "DUPE", matchCount: 3 });
    expect(c.detail).toContain("3");
    expect(c.remediation.action).toBe("review_duplicate");
  });
});