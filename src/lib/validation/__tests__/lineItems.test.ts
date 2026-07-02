import { describe, it, expect } from "vitest";
import { validateLineItems } from "../lineItems";

describe("validateLineItems", () => {
  it("rejects line with quantity 0", () => {
    const r = validateLineItems([
      { description: "Widget", quantity: 0, unit_price: 100 },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Line 1.*quantity/i);
  });

  it("rejects line with negative quantity", () => {
    const r = validateLineItems([
      { description: "Widget", quantity: -5, unit_price: 100 },
    ]);
    expect(r.ok).toBe(false);
  });

  it("accepts line with quantity > 0 and price >= 0", () => {
    const r = validateLineItems([
      { description: "Widget", quantity: 3, unit_price: 0 },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.valid).toHaveLength(1);
  });

  it("ignores untouched empty rows", () => {
    const r = validateLineItems([
      { description: "Widget", quantity: 2, unit_price: 50 },
      { description: "", quantity: 1, unit_price: 0 }, // default empty row
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.valid).toHaveLength(1);
  });

  it("rejects empty doc", () => {
    const r = validateLineItems([
      { description: "", quantity: 1, unit_price: 0 },
    ]);
    expect(r.ok).toBe(false);
  });

  it("flags row with description but qty 0 instead of silently dropping", () => {
    const r = validateLineItems([
      { description: "Widget", quantity: 0, unit_price: 100 },
      { description: "Other", quantity: 2, unit_price: 50 },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Line 1/);
  });

  it("supports quantity_ordered key for delivery notes", () => {
    const r = validateLineItems(
      [{ description: "Widget", quantity_ordered: 0, unit_price: 0 }],
      { quantityKey: "quantity_ordered" },
    );
    expect(r.ok).toBe(false);
  });

  it("enforces max_quantity for sales returns", () => {
    const r = validateLineItems(
      [{ description: "Widget", quantity: 10, max_quantity: 5, unit_price: 1 }],
      { enforceMaxQuantity: true },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/cannot exceed 5/);
  });
});
