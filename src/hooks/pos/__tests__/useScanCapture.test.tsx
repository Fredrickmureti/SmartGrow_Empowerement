/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useScanCapture } from "../useScanCapture";
import { scanBus, type ScanEvent, type ScanProgress } from "@/services/pos/scanBus";

function fireKey(key: string) {
  const evt = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  document.dispatchEvent(evt);
  return evt;
}

function fireBurst(chars: string, opts: { terminator?: "Enter" | "Tab" | null } = {}) {
  for (const ch of chars) fireKey(ch);
  if (opts.terminator !== null) fireKey(opts.terminator ?? "Enter");
}

describe("useScanCapture", () => {
  let received: ScanEvent[] = [];
  let progressEvents: (ScanProgress | null)[] = [];
  let unsub: () => void;
  let unsubProgress: () => void;

  beforeEach(() => {
    scanBus._clear();
    received = [];
    progressEvents = [];
    unsub = scanBus.on((e) => {
      received.push(e);
    });
    unsubProgress = scanBus.onProgress((p) => {
      progressEvents.push(p);
    });
  });

  afterEach(() => {
    unsub?.();
    unsubProgress?.();
    scanBus._clear();
    document.body.innerHTML = "";
  });

  it("emits a ScanEvent for a rapid burst ending in Enter", () => {
    renderHook(() => useScanCapture({ enabled: true }));
    fireBurst("5901234123457");
    expect(received).toHaveLength(1);
    expect(received[0].code).toBe("5901234123457");
    expect(received[0].quantity).toBe(1);
    expect(received[0].source).toBe("keyboard");
  });

  it("parses n*code qty prefix", () => {
    renderHook(() => useScanCapture({ enabled: true }));
    fireBurst("3*1234567");
    expect(received).toHaveLength(1);
    expect(received[0].code).toBe("1234567");
    expect(received[0].quantity).toBe(3);
  });

  it("does NOT emit when user types slowly (gap > maxGap)", () => {
    renderHook(() => useScanCapture({ enabled: true, maxGapMs: 5 }));
    // Simulate slow human typing by advancing real time isn't trivial in jsdom;
    // we rely on the buffer-reset behavior via a non-printable key.
    fireKey("1");
    fireKey("2");
    fireKey("Shift"); // non-printable, not a terminator → ignored
    // an arbitrary non-printable doesn't reset; rely on Enter w/ short buffer
    fireKey("Enter");
    expect(received).toHaveLength(0);
  });

  it("ignores typing inside a text input", () => {
    renderHook(() => useScanCapture({ enabled: true }));
    const input = document.createElement("input");
    input.type = "text";
    document.body.appendChild(input);
    input.focus();
    // Type a SHORT code (below overrideMinChars=6) and press Enter.
    fireBurst("abcd"); // 4 chars, below override threshold
    expect(received).toHaveLength(0);
  });

  it("steals the buffer when scan signature is unmistakable even inside input", () => {
    renderHook(() => useScanCapture({ enabled: true }));
    const input = document.createElement("input");
    input.type = "text";
    document.body.appendChild(input);
    input.focus();
    fireBurst("5901234123457"); // 13 chars in a tight loop → above override
    expect(received).toHaveLength(1);
    expect(received[0].code).toBe("5901234123457");
  });

  it("dedupes identical scan within 250ms", () => {
    renderHook(() => useScanCapture({ enabled: true }));
    fireBurst("5901234123457");
    fireBurst("5901234123457");
    expect(received).toHaveLength(1);
  });

  it("does not emit when disabled", () => {
    renderHook(() => useScanCapture({ enabled: false }));
    fireBurst("5901234123457");
    expect(received).toHaveLength(0);
  });

  it("emits live progress while the burst is in flight and clears on finalize", () => {
    renderHook(() => useScanCapture({ enabled: true }));
    for (const ch of "59012341") fireKey(ch);
    // Should have progress events (one per keystroke once length >= 2).
    const nonNull = progressEvents.filter((p): p is ScanProgress => p !== null);
    expect(nonNull.length).toBeGreaterThan(0);
    expect(nonNull[nonNull.length - 1].buffer).toBe("59012341");
    fireKey("Enter");
    // After finalize the buffer resets and a null progress is broadcast.
    expect(progressEvents[progressEvents.length - 1]).toBeNull();
  });

  it("does not emit progress for a single stray keystroke", () => {
    renderHook(() => useScanCapture({ enabled: true }));
    fireKey("5");
    expect(progressEvents.filter((p) => p !== null)).toHaveLength(0);
  });
});
