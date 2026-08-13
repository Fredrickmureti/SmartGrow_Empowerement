import { describe, it, expect } from "vitest";
import {
  mapAssistantResponseError,
  mapAssistantThrownError,
} from "./assistantErrors";

describe("mapAssistantResponseError", () => {
  it("treats 404 as an unreachable service, not a generic failure", () => {
    const mapped = mapAssistantResponseError(404, null);
    expect(mapped.kind).toBe("unreachable");
    expect(mapped.message).toMatch(/isn't available/i);
  });

  it("tells the user to sign in again on 401", () => {
    expect(mapAssistantResponseError(401, { error: "unauthorized" })).toMatchObject({
      kind: "unauthenticated",
      message: expect.stringMatching(/sign in again/i),
    });
  });

  it("surfaces the server reason on 403", () => {
    const mapped = mapAssistantResponseError(403, { reason: "AI add-on not enabled" });
    expect(mapped.kind).toBe("forbidden");
    expect(mapped.message).toBe("AI add-on not enabled");
  });

  it("maps 429 / 402 / 503 to their own kinds", () => {
    expect(mapAssistantResponseError(429, null).kind).toBe("rate_limited");
    expect(mapAssistantResponseError(402, null).kind).toBe("credits_exhausted");
    expect(mapAssistantResponseError(503, null).kind).toBe("unconfigured");
  });

  it("keeps server detail off the user-facing message for 5xx", () => {
    const mapped = mapAssistantResponseError(500, { error: "provider stack trace" });
    expect(mapped.kind).toBe("server_error");
    expect(mapped.message).not.toContain("provider stack trace");
    expect(mapped.detail).toBe("provider stack trace");
  });
});

describe("mapAssistantThrownError", () => {
  it("classifies a fetch rejection as unreachable", () => {
    const mapped = mapAssistantThrownError(new TypeError("Failed to fetch"));
    expect(mapped.kind).toBe("unreachable");
    expect(mapped.message).toMatch(/couldn't reach|offline/i);
  });

  it("falls back to a generic but non-silent message", () => {
    const mapped = mapAssistantThrownError(new Error("stream parse blew up"));
    expect(mapped.kind).toBe("unknown");
    expect(mapped.detail).toBe("stream parse blew up");
    expect(mapped.message).toMatch(/AI assistant/i);
  });
});
