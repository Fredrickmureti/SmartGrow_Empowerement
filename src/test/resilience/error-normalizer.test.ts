import { describe, it, expect } from "vitest";
import { normalizeError } from "@/services/resilience/ErrorNormalizer";

describe("normalizeError", () => {
  it("maps Failed to fetch -> offline with human message", () => {
    const n = normalizeError(new TypeError("Failed to fetch"));
    expect(n.kind).toBe("offline");
    expect(n.message).toMatch(/internet connection/i);
    expect(n.message).not.toMatch(/failed to fetch/i);
  });

  it("maps Safari Load failed -> offline", () => {
    const n = normalizeError(new TypeError("Load failed"));
    expect(n.kind).toBe("offline");
  });

  it("maps AbortError -> offline", () => {
    const e = new Error("aborted");
    e.name = "AbortError";
    expect(normalizeError(e).kind).toBe("offline");
  });

  it("maps Supabase 401 / JWT expired -> auth_expired", () => {
    expect(normalizeError({ status: 401, message: "JWT expired" }).kind).toBe("auth_expired");
    expect(normalizeError({ code: "PGRST301", message: "" }).kind).toBe("auth_expired");
  });

  it("maps invalid login credentials -> auth_invalid", () => {
    expect(normalizeError({ message: "Invalid login credentials" }).kind).toBe("auth_invalid");
  });

  it("maps 403 / permission denied -> permission_denied", () => {
    expect(normalizeError({ status: 403, message: "" }).kind).toBe("permission_denied");
    expect(normalizeError({ message: "permission denied for table foo" }).kind).toBe("permission_denied");
  });

  it("maps 5xx -> server_unavailable", () => {
    expect(normalizeError({ status: 503, message: "" }).kind).toBe("server_unavailable");
  });

  it("falls back to unknown for unrecognised shapes", () => {
    expect(normalizeError({ foo: "bar" }).kind).toBe("unknown");
  });

  it("passes an author-written business refusal through (P0001)", () => {
    const n = normalizeError({ code: "P0001", message: "Debits must equal credits." });
    expect(n.kind).toBe("validation");
    expect(n.message).toBe("Debits must equal credits.");
  });

  it("passes a business refusal raised as check_violation through (23514)", () => {
    const n = normalizeError({
      code: "23514",
      message: "Cannot post journal entry to closed fiscal period: Sep 2026",
    });
    expect(n.kind).toBe("validation");
    expect(n.message).toMatch(/closed fiscal period: Sep 2026/);
  });

  it("never renders a raw Postgres check-constraint failure (23514)", () => {
    const n = normalizeError({
      code: "23514",
      message: 'new row for relation "accounts" violates check constraint "accounts_code_check"',
    });
    expect(n.kind).toBe("validation");
    expect(n.message).not.toMatch(/constraint/i);
  });


  it("never leaks raw error.message into the user-facing message", () => {
    const raw = "stack trace at https://internal.host/secret";
    const n = normalizeError(new Error(raw));
    expect(n.message).not.toContain(raw);
  });

  it("passes through already-normalized errors", () => {
    const pre = normalizeError(new TypeError("Failed to fetch"));
    expect(normalizeError(pre)).toBe(pre);
  });
});