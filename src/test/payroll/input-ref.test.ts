/**
 * Contract test for the shared input_ref helpers (Phase 4 P1.3).
 *
 * Mirrors the Deno-side helper in `supabase/functions/_shared/inputRef.ts`.
 * Any change to one MUST be matched in the other.
 */
import { describe, it, expect } from "vitest";
import { parseInputRef, describeInputRef } from "@/lib/payroll/inputRef";

describe("parseInputRef", () => {
  it("returns null for legacy null source", () => {
    expect(parseInputRef(null)).toBeNull();
    expect(parseInputRef(undefined)).toBeNull();
    expect(parseInputRef({})).toBeNull();
  });

  it("returns null when input_ref has no kind", () => {
    expect(parseInputRef({ input_ref: {} })).toBeNull();
    expect(parseInputRef({ input_ref: { code: "overtime" } })).toBeNull();
  });

  it("extracts typed refs from a source jsonb", () => {
    const ref = parseInputRef({
      bracket_breakdown: [],
      input_ref: { kind: "statutory_rule", code: "PAYE", statutory_rule_id: "abc" },
    });
    expect(ref?.kind).toBe("statutory_rule");
    expect(ref?.code).toBe("PAYE");
  });
});

describe("describeInputRef", () => {
  it("falls back to a generic label per kind", () => {
    expect(describeInputRef({ kind: "contract" })).toMatch(/contract/i);
    expect(describeInputRef({ kind: "variable_input", code: "bonus" })).toMatch(/bonus/);
    expect(describeInputRef({ kind: "leave_request" })).toMatch(/leave/i);
    expect(describeInputRef({ kind: "garnishment" })).toMatch(/garnishment/i);
  });

  it("prefers an explicit label when provided", () => {
    expect(describeInputRef({ kind: "variable_input", label: "Custom" })).toBe("Custom");
  });
});
