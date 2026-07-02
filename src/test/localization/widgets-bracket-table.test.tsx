/**
 * Round 10 Step 7 — BracketTable widget DOM tests.
 *
 * Asserts the spreadsheet-style invariants Round 10 promised:
 *  - Add row defaults `lower` to previous row's `upper`, `upper=null`, `rate=0`.
 *  - "∞" toggle on last row maps to `null`; un-toggling restores numeric default.
 *  - Percent vs. fraction adornment driven by `itemsSchema.properties.rate.maximum`.
 */
import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { BracketTable } from "../../features/localization/components/widgets/BracketTable";

const PERCENT_SCHEMA = {
  type: "object",
  properties: {
    lower: { type: "number" },
    upper: { type: ["number", "null"] },
    rate: { type: "number", minimum: 0, maximum: 100 },
  },
};

const FRACTION_SCHEMA = {
  type: "object",
  properties: {
    min: { type: "number" },
    max: { type: ["number", "null"] },
    rate: { type: "number", minimum: 0, maximum: 1 },
  },
};

function Harness({ initial, itemsSchema }: { initial: any[]; itemsSchema: any }) {
  const [v, setV] = useState(initial);
  return (
    <div>
      <BracketTable value={v} onChange={setV} itemsSchema={itemsSchema} />
      <pre data-testid="value">{JSON.stringify(v)}</pre>
    </div>
  );
}

describe("BracketTable (Round 10 widget)", () => {
  it("renders the percent header when rate.maximum > 1", () => {
    render(<BracketTable value={[]} onChange={vi.fn()} itemsSchema={PERCENT_SCHEMA} />);
    expect(screen.getByText(/Rate \(%\)/)).toBeInTheDocument();
  });

  it("renders the fraction header when rate.maximum === 1", () => {
    render(<BracketTable value={[]} onChange={vi.fn()} itemsSchema={FRACTION_SCHEMA} />);
    expect(screen.getByText(/Rate \(0–1\)/)).toBeInTheDocument();
  });

  it("Add bracket seeds lower from previous upper, sets upper=null and rate=0", () => {
    render(
      <Harness
        initial={[{ lower: 0, upper: 24000, rate: 10 }]}
        itemsSchema={PERCENT_SCHEMA}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Add bracket/i }));
    const v = JSON.parse(screen.getByTestId("value").textContent!);
    expect(v).toHaveLength(2);
    expect(v[1]).toEqual({ lower: 24000, upper: null, rate: 0 });
  });

  it("∞ toggle maps to null, un-toggle restores a numeric value", () => {
    render(
      <Harness
        initial={[{ lower: 0, upper: 24000, rate: 10 }]}
        itemsSchema={PERCENT_SCHEMA}
      />,
    );
    const toggle = screen.getByRole("switch");
    fireEvent.click(toggle); // 24000 → null
    expect(JSON.parse(screen.getByTestId("value").textContent!)[0].upper).toBeNull();
    fireEvent.click(toggle); // null → numeric default (Math.max(lower, 0) = 0)
    expect(JSON.parse(screen.getByTestId("value").textContent!)[0].upper).toBe(0);
  });

  it("removes a bracket via the trash button", () => {
    render(
      <Harness
        initial={[
          { lower: 0, upper: 24000, rate: 10 },
          { lower: 24000, upper: null, rate: 25 },
        ]}
        itemsSchema={PERCENT_SCHEMA}
      />,
    );
    const removes = screen.getAllByLabelText(/Remove bracket/i);
    fireEvent.click(removes[0]);
    const v = JSON.parse(screen.getByTestId("value").textContent!);
    expect(v).toHaveLength(1);
    expect(v[0].lower).toBe(24000);
  });
});
