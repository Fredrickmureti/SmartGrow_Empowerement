/**
 * POS terminal global keyboard shortcut layer.
 *
 * Stage 2 of the POS overhaul. Implements the F-key shortcuts a supermarket
 * cashier expects so the hot path is keyboard-first, not mouse-first.
 *
 * Bindings (Odoo POS-aligned):
 *   F2  - focus product search
 *   F3  - edit qty for the currently selected line (handler decides)
 *   F4  - open discount dialog
 *   F5  - open customer picker
 *   F6  - hold current order
 *   F7  - recall held order (open held dialog)
 *   F8  - open payment dialog
 *   F9  - open cash drawer
 *   F10 - close current sale (after payment) / start new
 *   Esc - cancel / close active dialog (handled by dialog primitives, no-op here)
 *
 * Rules:
 *  - Disabled while focus is in an INPUT / TEXTAREA / contentEditable except for
 *    the search box (which we explicitly bring focus TO on F2).
 *  - Disabled when `enabled` is false (terminal locked, payment processing, …).
 *  - Each handler is optional; missing handlers are silently ignored so the
 *    consumer can wire them incrementally.
 */
import { useEffect, useRef } from "react";

export interface POSShortcutHandlers {
  onFocusSearch?: () => void;
  onEditQty?: () => void;
  onDiscount?: () => void;
  onCustomer?: () => void;
  onHold?: () => void;
  onRecallHeld?: () => void;
  onPay?: () => void;
  onCashDrawer?: () => void;
  onCloseSale?: () => void;
  /** Called when the user presses Esc and no dialog is open. */
  onEscape?: () => void;
}

interface Options extends POSShortcutHandlers {
  enabled?: boolean;
  /** Element id of the search input — focused on F2. Defaults to "pos-search". */
  searchInputId?: string;
}

const FKEY_MAP: Record<string, keyof POSShortcutHandlers> = {
  F2: "onFocusSearch",
  F3: "onEditQty",
  F4: "onDiscount",
  F5: "onCustomer",
  F6: "onHold",
  F7: "onRecallHeld",
  F8: "onPay",
  F9: "onCashDrawer",
  F10: "onCloseSale",
};

function isTextInput(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return true;
  if (el.isContentEditable) return true;
  return false;
}

export function usePOSKeyboardShortcuts(opts: Options) {
  const { enabled = true, searchInputId = "pos-search" } = opts;
  // Latest handlers in a ref so the effect doesn't rebind on every render.
  const handlersRef = useRef(opts);
  handlersRef.current = opts;

  useEffect(() => {
    if (!enabled) return;

    const onKeyDown = (e: KeyboardEvent) => {
      // F2 always works — explicitly moves focus into the search box.
      if (e.key === "F2") {
        e.preventDefault();
        const el = document.getElementById(searchInputId) as HTMLInputElement | null;
        if (el) {
          el.focus();
          el.select?.();
        }
        handlersRef.current.onFocusSearch?.();
        return;
      }

      // Escape — let dialogs handle their own close; only fire onEscape when
      // no dialog is currently open (Radix marks open dialogs with role).
      if (e.key === "Escape") {
        const openDialog = document.querySelector('[role="dialog"][data-state="open"]');
        if (!openDialog) {
          handlersRef.current.onEscape?.();
        }
        return;
      }

      // Suppress remaining shortcuts while typing.
      if (isTextInput(e.target)) return;

      const handlerKey = FKEY_MAP[e.key];
      if (!handlerKey) return;
      const handler = handlersRef.current[handlerKey];
      if (typeof handler === "function") {
        e.preventDefault();
        handler();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled, searchInputId]);
}

/**
 * Standard, user-facing label list — render in a help popover so cashiers can
 * see the bindings without leaving the hot path.
 */
export const POS_SHORTCUTS_HELP: Array<{ key: string; label: string }> = [
  { key: "F2", label: "Search products" },
  { key: "F3", label: "Edit quantity" },
  { key: "F4", label: "Discount" },
  { key: "F5", label: "Customer" },
  { key: "F6", label: "Hold order" },
  { key: "F7", label: "Recall held order" },
  { key: "F8", label: "Pay" },
  { key: "F9", label: "Cash drawer" },
  { key: "F10", label: "Close sale" },
  { key: "Esc", label: "Cancel" },
  { key: "n*<barcode>", label: "Scan barcode n times (e.g. 3*1234567)" },
];
