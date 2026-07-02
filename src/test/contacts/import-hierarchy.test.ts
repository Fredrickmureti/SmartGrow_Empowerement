/**
 * Phase 6 — Contact import / export round-trip.
 *
 * These tests pin the pure parsing helpers and exercise the two-pass batch
 * handler against a chainable Supabase mock. The goal is the round-trip
 * contract: anything `exportContacts` emits must re-import and reproduce the
 * same hierarchy + role flags.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---- Supabase mock: tiny chainable stub ----

type Row = Record<string, any>;
const state = {
  contacts: [] as Row[],
  inserts: [] as Row[],
  parentCreates: [] as Row[],
};

function makeQuery(table: string) {
  let rows: Row[] = table === "contacts" ? [...state.contacts] : [];
  const api: any = {
    select: vi.fn(() => api),
    eq: vi.fn((col: string, val: any) => {
      rows = rows.filter((r) => r[col] === val);
      return api;
    }),
    in: vi.fn((col: string, vals: any[]) => {
      const set = new Set(vals);
      rows = rows.filter((r) => set.has(r[col]));
      return api;
    }),
    ilike: vi.fn((col: string, val: string) => {
      const needle = String(val).toLowerCase();
      rows = rows.filter((r) => String(r[col] ?? "").toLowerCase() === needle);
      return api;
    }),
    limit: vi.fn(() => api),
    single: vi.fn(async () => ({ data: rows[0] ?? null, error: null })),
    insert: vi.fn((payload: Row | Row[]) => {
      const arr = Array.isArray(payload) ? payload : [payload];
      for (const r of arr) {
        const inserted = { id: `id-${state.contacts.length + 1}`, ...r };
        state.contacts.push(inserted);
        state.inserts.push(inserted);
        if (r.is_company) state.parentCreates.push(inserted);
      }
      const chain: any = {
        select: vi.fn(() => ({
          single: vi.fn(async () => ({
            data: { id: state.contacts[state.contacts.length - 1].id },
            error: null,
          })),
        })),
        then: (resolve: any) => resolve({ error: null }),
      };
      return chain;
    }),
    then: (resolve: any) => resolve({ data: rows, error: null }),
  };
  return api;
}

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: vi.fn((table: string) => makeQuery(table)),
  },
}));

vi.mock("@/lib/customerGroupResolver", () => ({
  CustomerGroupResolver: class {
    async resolve() { return null; }
  },
}));

import {
  parseImportBool,
  deriveRolesFromRow,
  createContactBatchImportHandler,
} from "@/lib/contactImportConfig";

beforeEach(() => {
  state.contacts = [];
  state.inserts = [];
  state.parentCreates = [];
});

describe("parseImportBool", () => {
  it("accepts common truthy/falsy tokens and returns undefined for blanks", () => {
    expect(parseImportBool("Yes")).toBe(true);
    expect(parseImportBool("TRUE")).toBe(true);
    expect(parseImportBool("1")).toBe(true);
    expect(parseImportBool("no")).toBe(false);
    expect(parseImportBool("0")).toBe(false);
    expect(parseImportBool("")).toBe(undefined);
    expect(parseImportBool(undefined)).toBe(undefined);
    expect(parseImportBool("maybe")).toBe(undefined);
  });
});

describe("deriveRolesFromRow", () => {
  it("prefers explicit is_customer / is_supplier over legacy type", () => {
    expect(deriveRolesFromRow({ is_customer: "yes", is_supplier: "yes", type: "customer" }))
      .toEqual({ customer_rank: 1, supplier_rank: 1, type: "both" });
    expect(deriveRolesFromRow({ is_customer: "no", is_supplier: "yes" }))
      .toEqual({ customer_rank: 0, supplier_rank: 1, type: "supplier" });
  });

  it("falls back to legacy `type` enum when no role flags present", () => {
    expect(deriveRolesFromRow({ type: "supplier" }))
      .toEqual({ customer_rank: 0, supplier_rank: 1, type: "supplier" });
    expect(deriveRolesFromRow({ type: "both" }))
      .toEqual({ customer_rank: 1, supplier_rank: 1, type: "both" });
    expect(deriveRolesFromRow({}))
      .toEqual({ customer_rank: 1, supplier_rank: 0, type: "customer" });
  });

  it("never emits a roleless contact when both flags are false", () => {
    expect(deriveRolesFromRow({ is_customer: "no", is_supplier: "no" }))
      .toEqual({ customer_rank: 1, supplier_rank: 0, type: "customer" });
  });
});

describe("createContactBatchImportHandler — two-pass parent resolution", () => {
  const handler = () => createContactBatchImportHandler("org-1", "biz-1");

  it("auto-creates a missing parent company in pass 1, then links the child in pass 2", async () => {
    const result = await handler()([
      { name: "Alice", parent_company_name: "Acme Ltd", is_customer: "yes" },
    ]);

    expect(result.errors).toEqual([]);
    // Acme should have been created as a company shell
    const acme = state.contacts.find((c) => c.name === "Acme Ltd");
    expect(acme).toBeDefined();
    expect(acme?.is_company).toBe(true);

    // Alice should reference Acme
    const alice = state.inserts.find((c) => c.name === "Alice");
    expect(alice?.parent_contact_id).toBe(acme?.id);
    expect(alice?.is_company).toBe(false);
    expect(alice?.customer_rank).toBe(1);
  });

  it("matches an existing company case-insensitively without creating a duplicate", async () => {
    state.contacts.push({
      id: "existing-acme",
      organization_id: "org-1",
      business_id: "biz-1",
      name: "Acme Ltd",
      is_company: true,
      is_active: true,
    });

    await handler()([
      { name: "Bob", parent_company_name: "acme ltd" },
    ]);

    const acmes = state.contacts.filter((c) => String(c.name).toLowerCase() === "acme ltd");
    expect(acmes).toHaveLength(1); // no duplicate
    const bob = state.inserts.find((c) => c.name === "Bob");
    expect(bob?.parent_contact_id).toBe("existing-acme");
  });

  it("does not assign a parent when is_company=true", async () => {
    await handler()([
      { name: "Globex Inc", is_company: "yes", parent_company_name: "Should Be Ignored" },
    ]);

    const globex = state.inserts.find((c) => c.name === "Globex Inc");
    expect(globex?.is_company).toBe(true);
    expect(globex?.parent_contact_id).toBeNull();
  });

  it("round-trips: exporter columns feed back into the importer and reproduce the hierarchy", async () => {
    // Simulated exporter output (what useExport.exportContacts would write)
    const exported = [
      { name: "Acme Ltd", is_company: "Yes", is_customer: "Yes", is_supplier: "No", parent_company_name: "" },
      { name: "Alice", is_company: "No", is_customer: "Yes", is_supplier: "No", parent_company_name: "Acme Ltd" },
      { name: "Bob", is_company: "No", is_customer: "No", is_supplier: "Yes", parent_company_name: "Acme Ltd" },
    ];

    await handler()(exported);

    const acme = state.contacts.find((c) => c.name === "Acme Ltd" && c.is_company === true);
    const alice = state.inserts.find((c) => c.name === "Alice");
    const bob = state.inserts.find((c) => c.name === "Bob");

    expect(acme).toBeDefined();
    expect(alice?.parent_contact_id).toBe(acme?.id);
    expect(bob?.parent_contact_id).toBe(acme?.id);
    expect(alice?.customer_rank).toBe(1);
    expect(alice?.supplier_rank).toBe(0);
    expect(bob?.supplier_rank).toBe(1);
    expect(bob?.customer_rank).toBe(0);
  });
});
