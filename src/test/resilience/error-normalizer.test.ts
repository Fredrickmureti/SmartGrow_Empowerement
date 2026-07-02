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