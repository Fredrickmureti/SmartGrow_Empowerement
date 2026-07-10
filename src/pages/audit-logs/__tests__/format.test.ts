import { describe, it, expect } from "vitest";
import {
  humanizeEntityType,
  humanizeAction,
  humanizeSentence,
  formatFieldName,
  formatFieldValue,
  diffValues,
  NOISE_KEYS,
} from "../format";

describe("humanizeEntityType", () => {
  it("uses curated overrides", () => {
    expect(humanizeEntityType("payroll_runs")).toBe("Payroll run");
    expect(humanizeEntityType("pos_transaction_items")).toBe("POS transaction line");
    expect(humanizeEntityType("employee_contract")).toBe("Employee contract");
  });
  it("falls back to Title Case + singularize", () => {
    expect(humanizeEntityType("shipment_notices")).toBe("Shipment Notice");
    expect(humanizeEntityType("policies")).toBe("Policy");
  });
  it("handles empty", () => {
    expect(humanizeEntityType(null)).toBe("Record");
    expect(humanizeEntityType("")).toBe("Record");
  });
});

describe("humanizeAction", () => {
  it("maps known verbs to tone + label", () => {
    expect(humanizeAction("posted")).toEqual({ label: "Posted", tone: "success" });
    expect(humanizeAction("reversed").tone).toBe("warning");
    expect(humanizeAction("deleted").tone).toBe("danger");
    expect(humanizeAction("updated").tone).toBe("info");
  });
  it("humanizes unknown verbs", () => {
    expect(humanizeAction("custom_verb").label).toBe("Custom Verb");
  });
});

describe("humanizeSentence", () => {
  it("includes entity name when present", () => {
    expect(
      humanizeSentence({ action: "posted", entityType: "invoices", entityName: "INV-0231" }),
    ).toBe("Invoice INV-0231 posted");
  });
  it("omits name gracefully", () => {
    expect(humanizeSentence({ action: "created", entityType: "employees", entityName: null }))
      .toBe("Employee created");
  });
});

describe("formatFieldName", () => {
  it("expands _id and snake_case", () => {
    expect(formatFieldName("customer_id")).toBe("Customer ID");
    expect(formatFieldName("invoice_number")).toBe("Invoice number");
  });
});

describe("formatFieldValue", () => {
  it("formats booleans and nulls", () => {
    expect(formatFieldValue("is_active", true)).toBe("Yes");
    expect(formatFieldValue("is_active", false)).toBe("No");
    expect(formatFieldValue("x", null)).toBe("—");
  });
  it("formats money-looking numbers with 2 decimals", () => {
    expect(formatFieldValue("total_amount", 1234.5)).toContain("1,234.50");
  });
  it("shortens UUIDs", () => {
    expect(formatFieldValue("customer_id", "abcdef12-3456-7890-abcd-ef1234567890"))
      .toBe("abcdef12…");
  });
  it("parses ISO datetimes", () => {
    expect(formatFieldValue("created_at", "2026-01-15T10:30:00Z")).toMatch(/Jan 15, 2026/);
  });
});

describe("diffValues", () => {
  it("returns only changed keys, sorted, no noise", () => {
    const out = diffValues(
      { id: "a", name: "Old", updated_at: "x", price: 10 },
      { id: "a", name: "New", updated_at: "y", price: 10 },
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ key: "name", before: "Old", after: "New", kind: "changed" });
  });
  it("classifies added/removed", () => {
    const out = diffValues({ a: 1 }, { a: 1, b: 2 });
    expect(out[0]).toMatchObject({ key: "b", kind: "added" });
    const out2 = diffValues({ a: 1, b: 2 }, { a: 1 });
    expect(out2[0]).toMatchObject({ key: "b", kind: "removed" });
  });
  it("noise keys opt-in", () => {
    for (const k of ["id", "updated_at", "organization_id"]) expect(NOISE_KEYS.has(k)).toBe(true);
    const out = diffValues({ updated_at: "a" }, { updated_at: "b" }, { includeNoise: true });
    expect(out).toHaveLength(1);
  });
});
