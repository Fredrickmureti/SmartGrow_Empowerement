/**
 * customersProvider — smoke test
 *
 * Verifies the basic shape contract: the provider issues an `ilike`
 * search on `contacts`, respects the abort signal, returns
 * record-kind CommandEntries with stable ids, and short-circuits
 * sub-2-char queries to avoid pummelling the DB.
 *
 * The supabase client is mocked so this stays a unit test.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock the supabase client BEFORE importing the provider ─────────
const orMock = vi.fn();
const eqMock = vi.fn();
const limitMock = vi.fn();
const abortMock = vi.fn();
const isMock = vi.fn();

const builder = {
  select: vi.fn(() => builder),
  or: vi.fn((...args: unknown[]) => { orMock(...args); return builder; }),
  eq: vi.fn((...args: unknown[]) => { eqMock(...args); return builder; }),
  is: vi.fn((...args: unknown[]) => { isMock(...args); return builder; }),
  limit: vi.fn((...args: unknown[]) => { limitMock(...args); return builder; }),
  abortSignal: vi.fn((...args: unknown[]) => {
    abortMock(...args);
    return Promise.resolve({
      data: [
        { id: "c1", name: "Acme Inc", email: "ops@acme.test", company: "Acme Inc" },
        { id: "c2", name: "Beta LLC", email: null, company: null },
      ],
      error: null,
    });
  }),
};

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn(() => builder) },
}));

import { customersProvider } from "../customers";
import type { ProviderContext } from "../types";

const ctx: ProviderContext = {
  signal: new AbortController().signal,
  currentAppId: null,
  organizationId: "org-1",
  userId: "user-1",
} as ProviderContext;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("customersProvider", () => {
  it("short-circuits queries shorter than 2 chars without hitting the DB", async () => {
    const out = await customersProvider.fetch("a", ctx);
    expect(out).toEqual([]);
    expect(builder.select).not.toHaveBeenCalled();
  });

  it("queries name / email / company with ilike and returns record entries", async () => {
    const out = await customersProvider.fetch("acme", ctx);

    expect(builder.select).toHaveBeenCalled();
    expect(orMock).toHaveBeenCalledWith(expect.stringContaining("name.ilike.%acme%"));
    expect(eqMock).toHaveBeenCalledWith("is_active", true);
    expect(limitMock).toHaveBeenCalledWith(8);
    expect(abortMock).toHaveBeenCalledWith(ctx.signal);

    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      id: "record:contact:c1",
      kind: "record",
      title: "Acme Inc",
      to: "/contacts/c1",
    });
    // Falls back gracefully when company/email are null.
    expect(out[1].subtitle).toBe("Contact");
  });

  it("escapes %/_ in user input to prevent ilike-injection", async () => {
    await customersProvider.fetch("100%_test", ctx);
    const arg = orMock.mock.calls[0][0] as string;
    expect(arg).toContain("100\\%\\_test");
  });

  it("declares conservative debounce + limit defaults", () => {
    expect(customersProvider.id).toBe("records:customers");
    expect(customersProvider.minQueryLength).toBe(2);
    expect(customersProvider.debounceMs).toBeGreaterThan(0);
    expect(customersProvider.limit).toBe(8);
  });
});
