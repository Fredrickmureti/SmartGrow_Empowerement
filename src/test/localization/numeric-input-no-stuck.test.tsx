/**
 * R15.2 — guard the "type 9 then -" trap reported in the admin pack editor.
 *
 * The previous controlled-`<Input type="number">` pattern would clobber the
 * field to `null` on an invalid keystroke, then `disabled={isNull}` would
 * lock it. After the migration to `NumericInput`, partial input is preserved
 * locally and the field never silently becomes disabled.
 */
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { NumericInput } from "@/components/ui/numeric-input";
import { useState } from "react";

function Harness({ initial = null as number | null }) {
  const [v, setV] = useState<number | null>(initial);
  return (
    <div>
      <NumericInput value={v} onValueChange={setV} aria-label="rate" />
      <span data-testid="state">{v === null ? "NULL" : String(v)}</span>
    </div>
  );
}

describe("NumericInput in localization editor — no stuck/disabled state", () => {
  it("preserves partial input and never disables on invalid keystrokes", () => {
    render(<Harness />);
    const input = screen.getByLabelText("rate") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "9" } });
    expect(screen.getByTestId("state").textContent).toBe("9");
    expect(input.disabled).toBe(false);

    // Browser-style invalid char on type=number reports "" in event.target.value.
    fireEvent.change(input, { target: { value: "" } });
    // State goes to NULL but the field is NOT disabled — user can keep typing.
    expect(screen.getByTestId("state").textContent).toBe("NULL");
    expect(input.disabled).toBe(false);

    fireEvent.change(input, { target: { value: "12" } });
    expect(screen.getByTestId("state").textContent).toBe("12");
    expect(input.disabled).toBe(false);
  });

  it("normalises on blur without locking the field", () => {
    render(<Harness initial={5} />);
    const input = screen.getByLabelText("rate") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    expect(input.disabled).toBe(false);
    expect(screen.getByTestId("state").textContent).toBe("NULL");
  });
});
