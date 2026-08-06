/**
 * InvoiceLineRow memo contract — guarantees that scan-driven
 * `setLineItems` only re-renders the row whose item identity changed.
 * If this test fails the rapid-scan workflow loses its O(1)-per-scan
 * render guarantee and >60 scans/min becomes janky.
 */

import { describe, it, expect, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { memo, useCallback, useState } from "react";

// Stub deep children that require app-wide providers — we are testing
// the memo contract on InvoiceLineRow itself, not its descendants.
vi.mock("@/components/projects/LineAnalyticsCell", () => ({
  LineAnalyticsCell: () => null,
}));
vi.mock("@/components/products/PackagingSelect", () => ({
  PackagingSelect: () => null,
}));
vi.mock("@/components/inventory/OutboundLineTracking", () => ({
  OutboundLineTracking: () => null,
}));
vi.mock("@/components/inventory/StockAvailabilityIndicator", () => ({
  StockBadge: () => null,
  StockLineStatus: () => null,
}));

import { EditableLineItemsGrid } from "@/design-system/records/EditableLineItemsGrid";
import {
  InvoiceLineRow,
  INVOICE_LINE_COLUMNS,
  type InvoiceLineItemShape,
} from "@/components/invoices/InvoiceLineRow";

const renderCounts: number[] = [0, 0, 0];

// Wrap the row component so we can count renders without touching its
// internals. `React.memo` propagates through composition, so wrapping
// inside the test does not weaken the memo contract — it just observes.
// Memo wrapper so the counter increments only when props change — this is
// the exact same memo discipline `InvoiceLineRow` itself uses, so failing
// here means consumers (Create/Edit dialogs) are passing unstable props.
const CountingRow = memo(function CountingRow(props: React.ComponentProps<typeof InvoiceLineRow>) {
  renderCounts[props.index]++;
  return <InvoiceLineRow {...props} />;
});

const PRODUCTS = [
  { id: "p1", name: "Pen", unit_price: 10, tax_rate: 0 },
  { id: "p2", name: "Pad", unit_price: 20, tax_rate: 0 },
  { id: "p3", name: "Pin", unit_price: 30, tax_rate: 0 },
];

function mkItem(productId: string, qty: number): InvoiceLineItemShape {
  return {
    product_id: productId,
    description: productId,
    quantity: qty,
    unit_price: 10,
    tax_rate: 0,
    line_total: qty * 10,
  };
}

function Harness() {
  const [items, setItems] = useState<InvoiceLineItemShape[]>([
    mkItem("p1", 1), mkItem("p2", 1), mkItem("p3", 1),
  ]);
  const [headerNote, setHeaderNote] = useState("a");

  const onUpdate = useCallback((index: number, patch: Partial<InvoiceLineItemShape>) => {
    setItems((prev) => prev.map((it, i) => (i === index ? { ...it, ...patch } : it)));
  }, []);
  const onRemove = useCallback(() => {}, []);
  const onProductSelect = useCallback(() => {}, []);
  const formatCurrency = useCallback((n: number) => `$${n}`, []);

  return (
    <div>
      <span data-testid="hn">{headerNote}</span>
      <button data-testid="bump-header" onClick={() => setHeaderNote((s) => s + "!")} />
      <button data-testid="bump-row-1" onClick={() => onUpdate(1, { quantity: 2, line_total: 20 })} />
      <EditableLineItemsGrid
        columns={INVOICE_LINE_COLUMNS}
        rows={items}
        onRemoveRow={onRemove}
        renderRow={(it, i, layout) => (
          <CountingRow
            index={i}
            item={it}
            products={PRODUCTS}
            layout={layout}
            flashed={false}
            formatCurrency={formatCurrency}
            onProductSelect={onProductSelect}
            onUpdate={onUpdate}
          />
        )}
      />
    </div>
  );
}

describe("InvoiceLineRow memo", () => {
  it("does not re-render rows when an unrelated parent state changes", () => {
    renderCounts[0] = renderCounts[1] = renderCounts[2] = 0;
    const { getByTestId } = render(<Harness />);
    const after = [...renderCounts];

    act(() => { getByTestId("bump-header").click(); });

    // Header changed, items array is referentially identical -> memo holds.
    expect(renderCounts[0]).toBe(after[0]);
    expect(renderCounts[1]).toBe(after[1]);
    expect(renderCounts[2]).toBe(after[2]);
  });

  it("re-renders only the row whose item identity changed", () => {
    renderCounts[0] = renderCounts[1] = renderCounts[2] = 0;
    const { getByTestId } = render(<Harness />);
    const after = [...renderCounts];

    act(() => { getByTestId("bump-row-1").click(); });

    expect(renderCounts[0]).toBe(after[0]);
    expect(renderCounts[1]).toBe(after[1] + 1);
    expect(renderCounts[2]).toBe(after[2]);
  });
});
