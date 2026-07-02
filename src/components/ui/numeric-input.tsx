import * as React from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * NumericInput
 * --------------------------------------------------------------------
 * A controlled numeric <input> that does NOT silently coerce empty
 * input back to a fallback value while the user is editing. This fixes
 * the long-standing UX issue where deleting "1" instantly restored "1",
 * making it impossible to type a new number cleanly.
 *
 *  - `value`: the current numeric value (number | null | undefined).
 *  - `onValueChange(next)`: called with `number` while the user types
 *    a valid number, or `null` when the field is empty.
 *  - Validation (e.g. quantity > 0) is the caller's responsibility at
 *    submit time, NOT during keystroke.
 *
 * Internally this stores the raw text the user is typing so partial
 * inputs like "" or "0." or "-" don't get rewritten under the cursor.
 */
export interface NumericInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type"> {
  value: number | null | undefined;
  onValueChange: (next: number | null) => void;
  allowDecimals?: boolean;
}

export const NumericInput = React.forwardRef<HTMLInputElement, NumericInputProps>(
  ({ value, onValueChange, allowDecimals = true, className, onBlur, ...rest }, ref) => {
    // Local text mirror so the field stays editable.
    const [text, setText] = React.useState<string>(
      value === null || value === undefined || Number.isNaN(value) ? "" : String(value),
    );

    // Sync from prop when it changes from outside (e.g. product picker fills price)
    // but NOT when the parent value just echoes what we already typed.
    React.useEffect(() => {
      const parsed = text === "" ? null : Number(text);
      const incoming = value ?? null;
      const same =
        (parsed === null && incoming === null) ||
        (parsed !== null && incoming !== null && Number(parsed) === Number(incoming));
      if (!same) {
        setText(incoming === null ? "" : String(incoming));
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [value]);

    return (
      <Input
        ref={ref}
        type="number"
        inputMode={allowDecimals ? "decimal" : "numeric"}
        step={allowDecimals ? "any" : "1"}
        className={cn(className)}
        value={text}
        onChange={(e) => {
          const raw = e.target.value;
          setText(raw);
          if (raw === "" || raw === "-" || raw === ".") {
            onValueChange(null);
            return;
          }
          const n = Number(raw);
          if (Number.isFinite(n)) {
            onValueChange(n);
          } else {
            onValueChange(null);
          }
        }}
        onBlur={(e) => {
          // Normalise on blur: empty / NaN -> null, otherwise rewrite text canonically.
          if (text === "" || !Number.isFinite(Number(text))) {
            setText("");
            onValueChange(null);
          } else {
            const n = Number(text);
            setText(String(n));
            onValueChange(n);
          }
          onBlur?.(e);
        }}
        {...rest}
      />
    );
  },
);
NumericInput.displayName = "NumericInput";
