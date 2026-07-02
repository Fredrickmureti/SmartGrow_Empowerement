/**
 * Round 10 unit tests — normalizeType + safe-fallback behaviour for the
 * SchemaForm renderer. Pure-function coverage; the editor-component DOM
 * tests are deferred until the broader supabase mock harness lands.
 */
import { describe, it, expect } from "vitest";
import { normalizeType } from "../../features/localization/SchemaForm";

describe("normalizeType (Round 10 nullable union handling)", () => {
  it("returns the primary type and nullable=true for ['number','null']", () => {
    expect(normalizeType({ type: ["number", "null"] })).toEqual({ type: "number", nullable: true });
  });
  it("returns the primary type and nullable=true for ['string','null']", () => {
    expect(normalizeType({ type: ["string", "null"] })).toEqual({ type: "string", nullable: true });
  });
  it("preserves single-string types", () => {
    expect(normalizeType({ type: "number" })).toEqual({ type: "number", nullable: false });
  });
  it("honours the OpenAPI-style nullable flag", () => {
    expect(normalizeType({ type: "number", nullable: true })).toEqual({ type: "number", nullable: true });
  });
  it("returns undefined type for empty / unknown shapes (so the editor can render the friendly diagnostic)", () => {
    expect(normalizeType({}).type).toBeUndefined();
    expect(normalizeType(null).type).toBeUndefined();
    expect(normalizeType(undefined).type).toBeUndefined();
  });
  it("does not collapse to 'null' as the primary type even if listed first", () => {
    expect(normalizeType({ type: ["null", "number"] })).toEqual({ type: "number", nullable: true });
  });
});
