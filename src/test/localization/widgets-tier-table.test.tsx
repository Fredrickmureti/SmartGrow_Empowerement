/**
 * Round 10 Step 7 — TierTable widget DOM tests.
 */
import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { TierTable } from "../../features/localization/components/widgets/TierTable";

const TIER_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string" },
    lower_earnings_limit: { type: "number" },
    upper_earnings_limit: { type: ["number", "null"] },
    employee_rate: { type: "number", minimum: 0, maximum: 100 },
    employer_rate: { type: "number", minimum: 0, maximum: 100 },
  },
};

function Harness({ initial }: { initial: any[] }) {
  const [v, setV] = useState(initial);
  return (
    <div>
      <TierTable value={v} onChange={setV} itemsSchema={TIER_SCHEMA} />
      <pre data-testid="value">{JSON.stringify(v)}</pre>
    </div>
  );
}

describe("TierTable (Round 10 widget)", () => {
  it("renders Employee + Employer headers", () => {
    render(<TierTable value={[]} onChange={vi.fn()} itemsSchema={TIER_SCHEMA} />);
    expect(screen.getByText(/Employee \(%\)/)).toBeInTheDocument();
    expect(screen.getByText(/Employer \(%\)/)).toBeInTheDocument();
  });

  it("Add tier seeds lower from previous upper, sets upper=null and rates=0", () => {
    render(
      <Harness
        initial={[{ name: "Tier I", lower_earnings_limit: 0, upper_earnings_limit: 7000, employee_rate: 6, employer_rate: 6 }]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Add tier/i }));
    const v = JSON.parse(screen.getByTestId("value").textContent!);
    expect(v).toHaveLength(2);
    expect(v[1]).toMatchObject({
      lower_earnings_limit: 7000,
      upper_earnings_limit: null,
      employee_rate: 0,
      employer_rate: 0,
    });
  });

  it("∞ toggle round-trips upper between null and a numeric default", () => {
    render(
      <Harness
        initial={[{ name: "Tier I", lower_earnings_limit: 0, upper_earnings_limit: 7000, employee_rate: 6, employer_rate: 6 }]}
      />,
    );
    const toggle = screen.getByRole("switch");
    fireEvent.click(toggle);
    expect(JSON.parse(screen.getByTestId("value").textContent!)[0].upper_earnings_limit).toBeNull();
    fireEvent.click(toggle);
    expect(JSON.parse(screen.getByTestId("value").textContent!)[0].upper_earnings_limit).toBe(0);
  });

  it("editing employee_rate persists, employer_rate untouched", () => {
    render(
      <Harness
        initial={[{ name: "Tier I", lower_earnings_limit: 0, upper_earnings_limit: 7000, employee_rate: 6, employer_rate: 6 }]}
      />,
    );
    const inputs = screen.getAllByRole("spinbutton") as HTMLInputElement[];
    // [lower, upper, employee_rate, employer_rate]
    fireEvent.change(inputs[2], { target: { value: "8" } });
    const v = JSON.parse(screen.getByTestId("value").textContent!);
    expect(v[0].employee_rate).toBe(8);
    expect(v[0].employer_rate).toBe(6);
  });
});
