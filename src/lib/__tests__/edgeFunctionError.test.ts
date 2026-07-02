/**
 * Regression tests for the payroll-reversal authorization hint mapping.
 *
 * Before the 2026-05-16 fix, every `PERMISSION_DENIED` (Postgres 42501)
 * coming back from the reverse-payroll edge function rendered the same
 * "ask an admin to add you to Payroll Admin / Payroll Officer" hint —
 * which was both wrong (no such access groups exist) and harmful
 * (it instructed organization owners to demote themselves to fix a bug
 * caused by service-role identity loss, not by a missing permission).
 *
 * The fix introduces hint-keyed messages so the same HTTP code can
 * render an identity-loss message, a true permission-denial message, or
 * the generic fallback depending on the RPC's `HINT`.
 */
import { describe, it, expect } from "vitest";
import { parseEdgeFunctionError } from "../edgeFunctionError";

function makeResponse(body: unknown, status = 403): { context: Response } {
  return {
    context: new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  };
}

describe("parseEdgeFunctionError — hint-aware permission messages", () => {
  it("uses the IDENTITY_REQUIRED copy when the RPC lost the caller", async () => {
    const err = makeResponse({
      error: "Caller identity is required for journal entry void",
      code: "PERMISSION_DENIED",
      hint: "IDENTITY_REQUIRED",
    });
    const parsed = await parseEdgeFunctionError(err);
    expect(parsed.code).toBe("PERMISSION_DENIED");
    expect(parsed.message).toMatch(/internal authorization error/i);
    expect(parsed.message).toMatch(/sign out and sign back in/i);
  });

  it("uses the PAYROLL_REVERSE_FORBIDDEN copy for a real payroll-reverse denial", async () => {
    const err = makeResponse({
      error: "User <uuid> lacks payroll.reverse for organization <uuid>",
      code: "PERMISSION_DENIED",
      hint: "PAYROLL_REVERSE_FORBIDDEN",
    });
    const parsed = await parseEdgeFunctionError(err);
    expect(parsed.message).toMatch(/permission to reverse payroll runs/i);
    expect(parsed.message).toMatch(/Payroll → Reverse/);
  });

  it("uses the FINANCE_VOID_JE_FORBIDDEN copy for journal-entry void denials", async () => {
    const err = makeResponse({
      error: "INSUFFICIENT_PRIVILEGE_JE_VOID",
      code: "PERMISSION_DENIED",
      hint: "FINANCE_VOID_JE_FORBIDDEN",
    });
    const parsed = await parseEdgeFunctionError(err);
    expect(parsed.message).toMatch(/void journal entries/i);
    expect(parsed.message).toMatch(/Finance → Void Journal Entry/);
  });

  it("falls back to the generic copy when no hint is provided", async () => {
    const err = makeResponse({
      error: "Some upstream denial",
      code: "PERMISSION_DENIED",
    });
    const parsed = await parseEdgeFunctionError(err);
    expect(parsed.message).toMatch(/don't have permission/i);
  });

  it("never instructs the user to join a non-existent Payroll Admin / Payroll Officer group", async () => {
    // Audit guard: the old harmful copy must not appear under any hint.
    for (const hint of [
      undefined,
      "IDENTITY_REQUIRED",
      "PAYROLL_REVERSE_FORBIDDEN",
      "FINANCE_VOID_JE_FORBIDDEN",
      "FINANCE_MANAGE_JE_FORBIDDEN",
    ]) {
      const err = makeResponse({
        error: "denied",
        code: "PERMISSION_DENIED",
        ...(hint ? { hint } : {}),
      });
      const parsed = await parseEdgeFunctionError(err);
      expect(parsed.message).not.toMatch(/Payroll Admin/);
      expect(parsed.message).not.toMatch(/Payroll Officer/);
    }
  });
});
