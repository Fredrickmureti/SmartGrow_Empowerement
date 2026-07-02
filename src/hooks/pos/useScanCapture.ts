/**
 * useScanCapture — global keyboard-wedge barcode kernel.
 *
 * Mounted exactly once near the POS terminal root. Listens for rapid
 * keystroke bursts ending in Enter/Tab and emits a structured ScanEvent on
 * `scanBus`. Consumers subscribe via scanBus.on(...) — never re-install
 * their own listener.
 *
 * Detection rules (Walmart-grade reliability):
 *   - Capture-phase keydown (beats any input that might preventDefault).
 *   - Defer when focus is in a text input/textarea/contenteditable UNLESS
 *     the burst signature is unmistakable (≥6 chars, ≤120ms cumulative,
 *     terminated by Enter/Tab) — then retroactively retract the chars.
 *   - Reset buffer whenever the inter-keystroke gap exceeds `maxGapMs`.
 *   - 250 ms dedupe window: ignore an identical re-emit (some scanners
 *     double-fire when configured with TAB+CR).
 *
 * The kernel does NOT do product resolution — that's useResolveBarcode.
 * Separation lets us unit-test detection vs. resolution independently.
 */

import { useEffect, useRef } from "react";
import { scanBus, type ScanEvent } from "@/services/pos/scanBus";
import { parseScanPayload } from "@/services/pos/parseBarcode";

interface Options {
  enabled?: boolean;
  minLength?: number;
  /** Max gap between keystrokes inside one scan burst. */
  maxGapMs?: number;
  /** Max total elapsed time for a "definite scan" override over text inputs. */
  overrideWindowMs?: number;
  /** Min char count to override focused text inputs. */
  overrideMinChars?: number;
}

const PRINTABLE_RE = /^[a-zA-Z0-9\-_.*\\/]$/;

/**
 * Inputs that opt OUT of scanner-driven character retraction. Add
 * `data-no-scanner-override` to any input whose user-typed content must
 * never be touched by the kernel (e.g. product name, free-text notes).
 */
const NO_OVERRIDE_ATTR = "data-no-scanner-override";

export function useScanCapture(opts: Options = {}) {
  const {
    enabled = true,
    minLength = 4,
    maxGapMs = 50,
    overrideWindowMs = 120,
    // Raised from 6 to 8: human "Tab"-completed words like "products"
    // are 8 chars but never come in under 120 ms; this band stays
    // scanner-only without hijacking trained typists.
    overrideMinChars = 8,
  } = opts;

  const bufferRef = useRef("");
  const startedAtRef = useRef(0);
  const lastKeyAtRef = useRef(0);
  const stolenFromInputRef = useRef<HTMLElement | null>(null);
  const lastEmitRef = useRef<{ code: string; at: number } | null>(null);

  useEffect(() => {
    if (!enabled) return;

    const isTextField = (el: EventTarget | null): el is HTMLElement => {
      if (!el || !(el instanceof HTMLElement)) return false;
      const tag = el.tagName;
      if (tag === "TEXTAREA") return true;
      if (tag === "INPUT") {
        const type = (el as HTMLInputElement).type;
        return ["text", "search", "number", "tel", "email", "url", "password", ""].includes(type);
      }
      return el.isContentEditable;
    };

    const resetBuffer = () => {
      bufferRef.current = "";
      startedAtRef.current = 0;
      stolenFromInputRef.current = null;
      scanBus.emitProgress(null);
    };

    /**
     * Retract chars that the scanner injected into a focused input before
     * we knew it was a scan. Uses the React-friendly native setter trick so
     * controlled <input> components see the value change through their
     * onChange synthetic handler.
     */
    const retractStolenChars = (input: HTMLInputElement, buf: string) => {
      try {
        if (!input.value.endsWith(buf)) return;
        const next = input.value.slice(0, -buf.length);
        const proto = input instanceof HTMLTextAreaElement
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        if (setter) {
          setter.call(input, next);
        } else {
          input.value = next;
        }
        input.dispatchEvent(new Event("input", { bubbles: true }));
      } catch {
        /* noop — best effort */
      }
    };

    const finalize = (raw: string) => {
      const parsed = parseScanPayload(raw);
      if (!parsed.code || parsed.code.length < minLength) return;
      const now = Date.now();
      const last = lastEmitRef.current;
      if (last && last.code === parsed.code && now - last.at < 250) return;
      lastEmitRef.current = { code: parsed.code, at: now };
      const event: ScanEvent = {
        raw,
        code: parsed.code,
        quantity: parsed.quantity,
        at: now,
        source: "keyboard",
      };
      scanBus.emit(event);
    };

    const handler = (e: KeyboardEvent) => {
      // Defensive: synthetic events (autofill, password managers, IME, some
      // Radix dialog focus transitions) can fire keydown without `key`.
      // Treat them as irrelevant rather than crashing the global listener.
      if (typeof e.key !== "string" || (e as any).isComposing) {
        return;
      }
      // Modifier keys (ctrl/meta/alt) → never a scan
      if (e.ctrlKey || e.metaKey || e.altKey) {
        resetBuffer();
        return;
      }

      const now = performance.now();
      const gap = now - lastKeyAtRef.current;
      const focusedTextField = isTextField(document.activeElement);

      // Terminator
      if (e.key === "Enter" || e.key === "Tab") {
        const buf = bufferRef.current ?? "";
        const elapsed = startedAtRef.current ? now - startedAtRef.current : 0;
        if ((buf?.length ?? 0) >= minLength) {
          // Decide: was this a scan burst? Yes if (a) we were NOT in a text
          // field, OR (b) the buffer hit override thresholds AND the focused
          // input has not explicitly opted out via data-no-scanner-override.
          const stolen = stolenFromInputRef.current;
          const optedOut =
            !!stolen && (stolen as HTMLElement).hasAttribute?.(NO_OVERRIDE_ATTR);
          const meetsOverride =
            buf.length >= overrideMinChars && elapsed <= overrideWindowMs;
          const isScan = !focusedTextField || (meetsOverride && !optedOut);
          if (isScan) {
            e.preventDefault();
            e.stopPropagation();
            if (stolen && (stolen as HTMLInputElement).value !== undefined) {
              retractStolenChars(stolen as HTMLInputElement, buf);
            }
            finalize(buf);
            resetBuffer();
            return;
          }
        }
        resetBuffer();
        return;
      }

      if (e.key.length !== 1 || !PRINTABLE_RE.test(e.key)) {
        // Non-printable, non-terminator: irrelevant to a scan.
        return;
      }

      // Restart buffer on slow keystroke.
      if (bufferRef.current.length > 0 && gap > maxGapMs) {
        resetBuffer();
      }
      if (bufferRef.current.length === 0) {
        startedAtRef.current = now;
        stolenFromInputRef.current = focusedTextField
          ? (document.activeElement as HTMLElement)
          : null;
      }
      bufferRef.current += e.key;
      lastKeyAtRef.current = now;

      // Live progress — the kernel-truth feed that powers the visible
      // "Walmart typing" effect. Throttle to buffer length ≥ 2 so a single
      // stray keystroke doesn't flash the overlay.
      if (bufferRef.current.length >= 2) {
        scanBus.emitProgress({
          buffer: bufferRef.current,
          at: Date.now(),
          source: "keyboard",
          committed:
            bufferRef.current.length >= overrideMinChars &&
            now - startedAtRef.current <= overrideWindowMs,
        });
      }
    };

    document.addEventListener("keydown", handler, { capture: true });
    return () => document.removeEventListener("keydown", handler, { capture: true } as any);
  }, [enabled, minLength, maxGapMs, overrideWindowMs, overrideMinChars]);
}
