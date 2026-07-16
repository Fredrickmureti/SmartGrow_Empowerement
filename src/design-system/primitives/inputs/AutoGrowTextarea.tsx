/**
 * AutoGrowTextarea — textarea that resizes vertically to fit its value.
 * Word-wrapping stays on; users can grab the drag handle for extra
 * height when desired. Used for legal notes, long labels, and any
 * multi-line field where clipping the value is unacceptable.
 */
import { forwardRef, useEffect, useRef, type TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

interface Props extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** Minimum height in lines. Default 2. */
  minRows?: number;
  /** Maximum height in CSS pixels before scrolling kicks in. Default 480. */
  maxHeight?: number;
  monospace?: boolean;
}

export const AutoGrowTextarea = forwardRef<HTMLTextAreaElement, Props>(
  function AutoGrowTextarea({ className, minRows = 2, maxHeight = 480, monospace, value, ...rest }, ref) {
    const innerRef = useRef<HTMLTextAreaElement | null>(null);

    useEffect(() => {
      const el = innerRef.current;
      if (!el) return;
      el.style.height = "auto";
      const next = Math.min(el.scrollHeight, maxHeight);
      el.style.height = `${next}px`;
      el.style.overflowY = el.scrollHeight > maxHeight ? "auto" : "hidden";
    }, [value, maxHeight]);

    return (
      <textarea
        ref={(node) => {
          innerRef.current = node;
          if (typeof ref === "function") ref(node);
          else if (ref) (ref as any).current = node;
        }}
        value={value}
        rows={minRows}
        className={cn(
          "flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm",
          "placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          "disabled:cursor-not-allowed disabled:opacity-50 resize-y",
          monospace && "font-mono text-[13px]",
          className,
        )}
        {...rest}
      />
    );
  },
);
