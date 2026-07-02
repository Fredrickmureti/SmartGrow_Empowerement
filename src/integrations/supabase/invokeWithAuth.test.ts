/**
 * Unit tests for invokeWithAuth — the deterministic auth wrapper for
 * Supabase edge-function invocations.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const invokeMock = vi.fn();
const getSessionMock = vi.fn();
const refreshSessionMock = vi.fn();

vi.mock("./client", () => ({
  supabase: {
    auth: {
      getSession: (...a: unknown[]) => getSessionMock(...a),
      refreshSession: (...a: unknown[]) => refreshSessionMock(...a),
    },
    functions: { invoke: (...a: unknown[]) => invokeMock(...a) },
  },
}));

import { invokeWithAuth, NotAuthenticatedError } from "./invokeWithAuth";

beforeEach(() => {
  invokeMock.mockReset();
  getSessionMock.mockReset();
  refreshSessionMock.mockReset();
});

describe("invokeWithAuth", () => {
  it("throws NotAuthenticatedError when there is no session", async () => {
    getSessionMock.mockResolvedValue({ data: { session: null }, error: null });
    await expect(invokeWithAuth("fn")).rejects.toBeInstanceOf(NotAuthenticatedError);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("throws NotAuthenticatedError when getSession errors", async () => {
    getSessionMock.mockResolvedValue({
      data: { session: null },
      error: new Error("boom"),
    });
    await expect(invokeWithAuth("fn")).rejects.toBeInstanceOf(NotAuthenticatedError);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("attaches Authorization: Bearer <token> on the happy path", async () => {
    getSessionMock.mockResolvedValue({
      data: {
        session: {
          access_token: "tok-123",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        },
      },
      error: null,
    });
    invokeMock.mockResolvedValue({ data: { ok: true }, error: null });

    const res = await invokeWithAuth("install-localization-pack", { body: { x: 1 } });

    expect(res).toEqual({ data: { ok: true }, error: null });
    expect(invokeMock).toHaveBeenCalledTimes(1);
    const [name, options] = invokeMock.mock.calls[0];
    expect(name).toBe("install-localization-pack");
    expect(options.body).toEqual({ x: 1 });
    expect(options.headers.Authorization).toBe("Bearer tok-123");
    expect(refreshSessionMock).not.toHaveBeenCalled();
  });

  it("refreshes the session when the token is near expiry", async () => {
    getSessionMock.mockResolvedValue({
      data: {
        session: {
          access_token: "old-tok",
          expires_at: Math.floor(Date.now() / 1000) + 5, // within window
        },
      },
      error: null,
    });
    refreshSessionMock.mockResolvedValue({
      data: { session: { access_token: "new-tok", expires_at: Math.floor(Date.now() / 1000) + 3600 } },
      error: null,
    });
    invokeMock.mockResolvedValue({ data: {}, error: null });

    await invokeWithAuth("fn");

    expect(refreshSessionMock).toHaveBeenCalledTimes(1);
    const [, options] = invokeMock.mock.calls[0];
    expect(options.headers.Authorization).toBe("Bearer new-tok");
  });

  it("throws NotAuthenticatedError when refresh fails", async () => {
    getSessionMock.mockResolvedValue({
      data: {
        session: {
          access_token: "old-tok",
          expires_at: Math.floor(Date.now() / 1000) + 5,
        },
      },
      error: null,
    });
    refreshSessionMock.mockResolvedValue({
      data: { session: null },
      error: new Error("expired"),
    });

    await expect(invokeWithAuth("fn")).rejects.toBeInstanceOf(NotAuthenticatedError);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
