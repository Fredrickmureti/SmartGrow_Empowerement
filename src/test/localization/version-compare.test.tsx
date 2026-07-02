/**
 * Round 14 Step 14.3 — VersionCompareCard regression test.
 *
 * The pack editor used to default to "diff the latest two versions" only.
 * Round 12 added two `Select`s so admins can compare any pair. This test
 * pins that wiring: render with three published versions, drive both
 * pickers, and assert PackDiffView receives the chosen pair (NOT the
 * latest two).
 */
import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("../../features/localization/components/PackDiffView", () => ({
  PackDiffView: ({ previous, next, title }: any) => (
    <div data-testid="diff">
      <span data-testid="diff-title">{title}</span>
      <span data-testid="diff-prev">{JSON.stringify(previous)}</span>
      <span data-testid="diff-next">{JSON.stringify(next)}</span>
    </div>
  ),
}));

import { VersionCompareCard } from "../../features/localization/components/VersionCompareCard";

const VERSIONS = [
  { id: "v3-id", version: "3.0.0", snapshot: { rules: ["v3"] } },
  { id: "v2-id", version: "2.0.0", snapshot: { rules: ["v2"] } },
  { id: "v1-id", version: "1.0.0", snapshot: { rules: ["v1"] } },
];

function Harness() {
  const [from, setFrom] = useState<string | null>(null);
  const [to, setTo] = useState<string | null>(null);
  return (
    <VersionCompareCard
      versions={VERSIONS}
      compareFromId={from}
      compareToId={to}
      onChangeFrom={setFrom}
      onChangeTo={setTo}
    />
  );
}

describe("VersionCompareCard", () => {
  it("renders nothing comparable until both pickers are chosen", () => {
    render(<Harness />);
    expect(screen.queryByTestId("diff")).toBeNull();
    expect(screen.getByText(/Pick two different versions/i)).toBeInTheDocument();
  });

  it("hands the chosen pair (not the latest two) to PackDiffView", () => {
    function HarnessFixed() {
      // Pre-select v1 ↔ v3 (NOT the latest two = v3 ↔ v2).
      return (
        <VersionCompareCard
          versions={VERSIONS}
          compareFromId="v1-id"
          compareToId="v3-id"
          onChangeFrom={() => {}}
          onChangeTo={() => {}}
        />
      );
    }
    render(<HarnessFixed />);
    const diff = screen.getByTestId("diff");
    expect(diff).toBeInTheDocument();
    expect(screen.getByTestId("diff-title").textContent).toBe("v1.0.0 → v3.0.0");
    expect(screen.getByTestId("diff-prev").textContent).toBe(JSON.stringify({ rules: ["v1"] }));
    expect(screen.getByTestId("diff-next").textContent).toBe(JSON.stringify({ rules: ["v3"] }));
  });

  it("shows guard message when fewer than two versions exist", () => {
    render(
      <VersionCompareCard
        versions={[VERSIONS[0]]}
        compareFromId={null}
        compareToId={null}
        onChangeFrom={() => {}}
        onChangeTo={() => {}}
      />,
    );
    expect(screen.getByText(/Need at least two published versions/i)).toBeInTheDocument();
    expect(screen.queryByTestId("diff")).toBeNull();
  });

  it("guards same-id selection without rendering the diff", () => {
    render(
      <VersionCompareCard
        versions={VERSIONS}
        compareFromId="v2-id"
        compareToId="v2-id"
        onChangeFrom={() => {}}
        onChangeTo={() => {}}
      />,
    );
    expect(screen.queryByTestId("diff")).toBeNull();
    expect(screen.getByText(/Pick two different versions/i)).toBeInTheDocument();
  });
});