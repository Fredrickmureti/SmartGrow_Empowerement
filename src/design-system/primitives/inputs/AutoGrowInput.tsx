/**
 * AutoGrowInput — single-line input that grows horizontally with its
 * content so the value is always visible. For long values, users can
 * still switch to the ExpandableTextField pattern; this control is the
 * default for labels, codes, bind keys and similar identifiers used
 * throughout authoring surfaces (Localization Editor, form designers).
 *
 * The width is measured off-screen with a mirror <span> that copies the
 * input's typography, so the growth is pixel-accurate.
 */
import { forwardRef, useLayoutEffect, useRef, useState, type InputHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

interface Props extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  /** Minimum width in CSS units. Default 8rem. */
  minWidth?: string;
  /** Maximum width in CSS units. Default 100%. */
  maxWidth?: string;
  /** Monospace font for machine values (codes, bind keys). */
  monospace?: boolean;
}

export const AutoGrowInput = forwardRef<HTMLInputElement, Props>(function AutoGrowInput(
  { className, minWidth = "8rem", maxWidth = "100%", monospace, value, defaultValue, placeholder, ...rest },
  ref,
) {
  const mirrorRef = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState<string>(minWidth);
  const display = String(value ?? defaultValue ?? "");

  useLayoutEffect(() => {
    if (!mirrorRef.current) return;
    // Measure the greater of the value and placeholder so the field
    // never shrinks below the placeholder width.
    mirrorRef.current.textContent = display || placeholder || "";
    const w = mirrorRef.current.offsetWidth;
    // +18px for caret + horizontal padding.
    setWidth(`min(${maxWidth}, max(${minWidth}, ${w + 18}px))`);
  }, [display, placeholder, minWidth, maxWidth]);

  return (
    <span className="relative inline-block w-full">
      <input
        ref={ref}
        value={value}
        defaultValue={defaultValue}
        placeholder={placeholder}
        className={cn(
          "flex h-9 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors",
          "placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          "disabled:cursor-not-allowed disabled:opacity-50",
          monospace && "font-mono text-[13px]",
          className,
        )}
        style={{ width }}
        {...rest}
      />
      <span
        ref={mirrorRef}
        aria-hidden="true"
        className={cn(
          "invisible absolute left-0 top-0 whitespace-pre px-3 text-sm",
          monospace && "font-mono text-[13px]",
        )}
      />
    </span>
  );
});
