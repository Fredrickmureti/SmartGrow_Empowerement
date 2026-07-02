/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";
import { ScanGhostTicker } from "../ScanGhostTicker";
import { scanBus } from "@/services/pos/scanBus";
import { scanFeedbackBus } from "@/services/pos/scanFeedbackBus";

describe("ScanGhostTicker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    scanBus._clear();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    scanBus._clear();
  });

  it("renders the accumulating buffer on progress events", () => {
    render(<ScanGhostTicker />);
    act(() => {
      scanBus.emitProgress({ buffer: "590", at: Date.now(), source: "keyboard", committed: false });
    });
    expect(screen.getByRole("status").textContent).toContain("590");
  });

  it("swaps to a success badge when feedback fires and disappears after TTL", () => {
    render(<ScanGhostTicker />);
    act(() => {
      scanBus.emitProgress({ buffer: "5901234", at: Date.now(), source: "keyboard", committed: true });
      scanFeedbackBus.emit({ kind: "ok", raw: "5901234", detail: "Cola 500ml" });
    });
    expect(screen.getByRole("status").textContent).toContain("Cola 500ml");
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("hides progress chip after idle timeout when no finalize arrives", () => {
    render(<ScanGhostTicker />);
    act(() => {
      scanBus.emitProgress({ buffer: "12", at: Date.now(), source: "keyboard", committed: false });
    });
    expect(screen.getByRole("status")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("keeps the pending badge visible until a final feedback arrives", () => {
    render(<ScanGhostTicker />);
    act(() => {
      scanFeedbackBus.emit({ kind: "pending", raw: "5901234", detail: "Looking up…" });
    });
    expect(screen.getByRole("status").textContent).toContain("Looking up");
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    // Pending stays — final feedback hasn't fired yet.
    expect(screen.getByRole("status").textContent).toContain("Looking up");
    act(() => {
      scanFeedbackBus.emit({ kind: "ok", raw: "5901234", detail: "Cola" });
    });
    expect(screen.getByRole("status").textContent).toContain("Cola");
  });
});
