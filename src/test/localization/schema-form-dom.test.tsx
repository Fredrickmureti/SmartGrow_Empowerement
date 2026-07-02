/**
 * Round 10 Step 7 — DOM coverage for SchemaForm.
 *
 * Asserts the three guarantees Round 10 promised:
 *  1. Nullable-number renders a number input + a "—" toggle that persists null.
 *  2. Editing a string field does NOT swap the focused DOM node (Round 10
 *     stable-identity fix).
 *  3. Unknown / object-shaped values at the unknown branch render the
 *     friendly diagnostic Alert and never the literal "[object Object]".
 */
import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { SchemaForm } from "../../features/localization/SchemaForm";

function Harness({ schema, initial }: { schema: any; initial: any }) {
  const [v, setV] = useState(initial);
  return (
    <div>
      <SchemaForm schema={schema} value={v} onChange={setV} />
      <pre data-testid="value">{JSON.stringify(v)}</pre>
    </div>
  );
}

describe("SchemaForm DOM (Round 10 stable-identity + nullable + safe fallback)", () => {
  it("renders nullable number with a — toggle that persists null", () => {
    const onChange = vi.fn();
    render(<SchemaForm schema={{ type: ["number", "null"] }} value={5} onChange={onChange} />);
    const input = screen.getByRole("spinbutton") as HTMLInputElement;
    expect(input.type).toBe("number");
    expect(input.value).toBe("5");

    // Click the "—" toggle (single icon-only button next to the input).
    const toggle = screen.getByRole("button");
    fireEvent.click(toggle);
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it("does NOT swap input identity when typing into a nested string field", () => {
    render(
      <Harness
        schema={{
          type: "object",
          properties: { rule_name: { type: "string" } },
        }}
        initial={{ rule_name: "" }}
      />,
    );
    const before = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(before, { target: { value: "P" } });
    fireEvent.change(before, { target: { value: "PA" } });
    fireEvent.change(before, { target: { value: "PAY" } });
    const after = screen.getByRole("textbox") as HTMLInputElement;
    // Same DOM node across re-renders → no focus loss.
    expect(after).toBe(before);
    expect(after.value).toBe("PAY");
    expect(JSON.parse(screen.getByTestId("value").textContent!)).toEqual({ rule_name: "PAY" });
  });

  it("renders a friendly diagnostic (never [object Object]) for unsupported value shapes", () => {
    // Empty schema + object value → falls into the unknown-shape branch.
    render(<SchemaForm schema={{}} value={{ nested: { deep: 1 } }} onChange={() => {}} />);
    expect(screen.getByText(/Unsupported schema shape/i)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\[object Object\]/);
  });

  it("ObjectField with a non-primitive value never coerces to [object Object] in the Input", () => {
    // Defensive coverage for the PrimitiveField defensive coerce on line 160.
    render(
      <SchemaForm
        schema={{ type: "string" }}
        value={{ shouldNotHappen: true } as any}
        onChange={() => {}}
      />,
    );
    const input = screen.getByRole("textbox") as HTMLInputElement;
    expect(input.value).toBe("");
    expect(document.body.textContent).not.toMatch(/\[object Object\]/);
  });
});
