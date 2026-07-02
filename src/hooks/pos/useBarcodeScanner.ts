import { useEffect, useCallback, useRef } from "react";

interface UseBarcodeScanner {
  /**
   * Called when a scan is detected. `quantity` is parsed from the optional
   * `n*<barcode>` Odoo-style qty multiplier (e.g. "3*1234567" -> qty 3).
   */
  onScan: (barcode: string, quantity: number) => void;
  enabled?: boolean;
  minLength?: number;
  maxDelay?: number;
}

/**
 * @deprecated POS surfaces must subscribe to `scanBus` instead — the central
 * `useScanCapture` kernel mounted inside `POSTerminal` is the single source
 * of scan events. This hook remains for legacy non-POS screens (inventory
 * receiving, etc.) until they migrate to the bus.
 *
 * Detect rapid keystroke bursts ending in Enter — the universal signal of a
 * barcode scanner — and emit the captured payload to `onScan`.
 *
 * Hardened in Stage 2:
 *  - Skips when focus is in a text input (let the user type freely).
 *  - Supports `n*<barcode>` qty multiplier.
 *  - Resets buffer on slow keystrokes (slower than `maxDelay`) so a human
 *    typing in the URL bar can't accidentally form a "barcode".
 */
export function useBarcodeScanner({
  onScan,
  enabled = true,
  minLength = 4,
  maxDelay = 50,
}: UseBarcodeScanner) {
  const bufferRef = useRef<string>("");
  const lastKeystrokeRef = useRef<number>(0);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(() => {
    const raw = bufferRef.current;
    bufferRef.current = "";
    const { code, quantity } = parseBarcodePayload(raw);
    if (code.length >= minLength) {
      onScan(code, quantity);
    }
  }, [minLength, onScan]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (!enabled) return;

      const target = event.target as HTMLElement;
      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable
      ) {
        return;
      }

      const now = Date.now();
      const timeSinceLastKeystroke = now - lastKeystrokeRef.current;

      if (timeSinceLastKeystroke > maxDelay && bufferRef.current.length > 0) {
        bufferRef.current = "";
      }
      lastKeystrokeRef.current = now;

      if (event.key === "Enter") {
        if (bufferRef.current.length >= minLength) {
          event.preventDefault();
          flush();
        } else {
          bufferRef.current = "";
        }
        return;
      }

      // Accept alphanumerics, scanner-safe punctuation, and the `*` qty
      // separator.
      if (event.key.length === 1 && /[a-zA-Z0-9\-_.*]/.test(event.key)) {
        bufferRef.current += event.key;

        if (timeoutRef.current) clearTimeout(timeoutRef.current);
        timeoutRef.current = setTimeout(() => {
          bufferRef.current = "";
        }, 200);
      }
    },
    [enabled, maxDelay, minLength, flush]
  );

  useEffect(() => {
    if (enabled) {
      window.addEventListener("keydown", handleKeyDown);
    }
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [enabled, handleKeyDown]);

  const clearBuffer = useCallback(() => {
    bufferRef.current = "";
  }, []);

  return { clearBuffer };
}

/**
 * Pure parser for the Odoo-style `n*<barcode>` shortcut.
 * Exported for unit testing.
 */
export function parseBarcodePayload(payload: string): { code: string; quantity: number } {
  const trimmed = payload.trim();
  const match = trimmed.match(/^(\d+)\*(.+)$/);
  if (match) {
    const n = parseInt(match[1], 10);
    if (Number.isFinite(n) && n > 0 && n <= 9999) {
      return { code: match[2], quantity: n };
    }
  }
  return { code: trimmed, quantity: 1 };
}
