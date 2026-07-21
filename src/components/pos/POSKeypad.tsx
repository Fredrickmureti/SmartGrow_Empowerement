/**
 * POSKeypad — responsive numeric keypad for POS amount entry.
 *
 * Wraps `react-simple-keyboard` with a POS-specific numeric layout and
 * design-token theme (see `pos-keypad.css`). Keys scale to fill the
 * container's height so the keypad never overflows on smaller laptop
 * viewports — this is the fix for the tender-page overflow bug.
 *
 * Props match the legacy `NumericKeypad` shape so callers don't change.
 */
import { useMemo } from "react";
import Keyboard from "react-simple-keyboard";
import "react-simple-keyboard/build/css/index.css";
import "./pos-keypad.css";
import { cn } from "@/lib/utils";

interface POSKeypadProps {
  value: string;
  onChange: (value: string) => void;
  onClear: () => void;
  onBackspace: () => void;
  /** Whether to show a "." key. Defaults true. When false, "00" replaces it. */
  showDecimal?: boolean;
  maxLength?: number;
  className?: string;
}

export function POSKeypad({
  value,
  onChange,
  onClear,
  onBackspace,
  showDecimal = true,
  maxLength = 10,
  className,
}: POSKeypadProps) {
  const layout = useMemo(
    () => ({
      default: [
        "7 8 9",
        "4 5 6",
        "1 2 3",
        `${showDecimal ? "{dot}" : "{doublezero}"} 0 {bksp}`,
        "{clear}",
      ],
    }),
    [showDecimal],
  );

  const display = useMemo(
    () => ({
      "{bksp}": "⌫",
      "{clear}": "Clear",
      "{dot}": ".",
      "{doublezero}": "00",
    }),
    [],
  );

  const handleKeyPress = (button: string) => {
    if (button === "{bksp}") {
      onBackspace();
      return;
    }
    if (button === "{clear}") {
      onClear();
      return;
    }
    if (value.length >= maxLength) return;

    if (button === "{dot}") {
      if (value.includes(".")) return;
      onChange(value === "" ? "0." : value + ".");
      return;
    }
    if (button === "{doublezero}") {
      if (value.length + 2 > maxLength) return;
      onChange(value === "" ? "0" : value + "00");
      return;
    }
    // Digit
    onChange(value + button);
  };

  return (
    <div className={cn("pos-keypad", className)}>
      <Keyboard
        layoutName="default"
        layout={layout}
        display={display}
        onKeyPress={handleKeyPress}
        theme="hg-theme-default"
        useButtonTag
        disableCaretPositioning
        preventMouseDownDefault
      />
    </div>
  );
}

export default POSKeypad;
