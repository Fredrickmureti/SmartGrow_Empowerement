/**
 * Regression test for the misleading
 *   "Terminal lock only available in desktop app"
 * error that POS users saw in the Electron app when connectivity
 * dropped. The TerminalLockService must now return a structured
 * `reason` so callers can render an accurate, human message.
 */
import { describe, it, expect } from "vitest";
import { terminalLockService } from "@/services/offline/TerminalLockService";
import { normalizeError } from "@/services/resilience/ErrorNormalizer";

describe("terminalLockService.unlockWithPin (non-electron runtime)", () => {
  it("returns a structured reason instead of a string-only error", async () => {
    // jsdom: window.pos is undefined -> isElectron() === false.
    const result = await terminalLockService.unlockWithPin("1234", "org-1");
    expect(result.success).toBe(false);
    expect(result.reason).toBe("not-electron");
    // The message must not blame the user for "not using desktop" when
    // the real situation may be "internet is down".
    expect(result.error).not.toMatch(/only available in desktop/i);
    expect(result.error).toMatch(/reconnect|internet|try again/i);
  });
});

describe("normalizeError handles raw network failures from auth", () => {
  it("renders an offline message instead of `Failed to fetch`", () => {
    const n = normalizeError(new TypeError("Failed to fetch"));
    expect(n.kind).toBe("offline");
    expect(n.message).toMatch(/check your internet/i);
  });
});