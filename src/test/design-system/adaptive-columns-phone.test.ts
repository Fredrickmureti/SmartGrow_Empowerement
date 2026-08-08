/**
 * Phone-rail regression: an invoice line grid inside a ~330px card cannot
 * hold "Item" (240) + "Total" (110) side by side. It must demote instead of
 * producing a sideways scrollbar (and a Total value that overflows the row).
 */
import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useAdaptiveLayout } from "@/design-system/records/adaptiveColumns";
import { INVOICE_LINE_COLUMNS } from "@/components/invoices/InvoiceLineRow";

function layoutAt(width: number, reserved = 52) {
  const { result } = renderHook(() =>
    useAdaptiveLayout(INVOICE_LINE_COLUMNS, width, reserved),
  );
  return result.current;
}

describe("adaptive line columns on a phone", () => {
  it("keeps only the item column at 330px and never scrolls sideways", () => {
    const l = layoutAt(330);
    expect(l.visible.map((c) => c.id)).toEqual(["item"]);
    expect(l.demoted.map((c) => c.id)).toContain("line_total");
    expect(l.needsScroll).toBe(false);
  });

  it("still shows the total column when the container is wide", () => {
    const l = layoutAt(900);
    expect(l.visible.map((c) => c.id)).toContain("line_total");
    expect(l.needsScroll).toBe(false);
  });
});
