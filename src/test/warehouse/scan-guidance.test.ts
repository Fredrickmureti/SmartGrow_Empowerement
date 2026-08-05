/**
 * Scan guidance + router notification unit tests (Phase 4.1 – 4.3).
 *
 * These pin the two things a guidance surface cannot fake: that every
 * mounted intent has operator copy (a missing entry would silently degrade
 * to "Ready to scan"), and that the router actually announces target
 * changes instead of being polled.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { scanRouter } from "@/services/pos/scanRouter";
import {
  intentFromTargetLabel,
  promptForIntent,
  classifyFeedback,
  describeScanSource,
} from "@/features/warehouse/scanning/scanGuidance";
import type { WmsScanIntent } from "@/features/warehouse/scanning/wmsScanIntent";

/** Read the intent union straight from the source of truth. */
function declaredIntents(): WmsScanIntent[] {
  const src = readFileSync(
    join(process.cwd(), "src/features/warehouse/scanning/wmsScanIntent.ts"),
    "utf8",
  );
  const block = src.slice(src.indexOf("export type WmsScanIntent"), src.indexOf("/** Normalised payload"));
  return Array.from(block.matchAll(/\|\s*"([a-z_]+\.[a-z_]+)"/g)).map((m) => m[1] as WmsScanIntent);
}

afterEach(() => scanRouter._clear());

describe("scan guidance copy", () => {
  const intents = declaredIntents();

  it("finds the declared intent union", () => {
    expect(intents.length).toBeGreaterThan(15);
  });

  it("has operator copy for every declared intent", () => {
    const missing = intents.filter((i) => promptForIntent(i) === null);
    expect(missing, `Intents without guidance copy: ${missing.join(", ")}`).toEqual([]);
  });

  it("every prompt is an instruction plus an outcome", () => {
    for (const i of intents) {
      const p = promptForIntent(i)!;
      expect(p.what.startsWith("Scan"), `${i}: "${p.what}" must be an imperative`).toBe(true);
      expect(p.then.length).toBeGreaterThan(4);
    }
  });

  it("recovers the intent from a router target label", () => {
    expect(intentFromTargetLabel("wms:pack.carton")).toBe("pack.carton");
    expect(intentFromTargetLabel("wms:not.real")).toBeNull();
    expect(intentFromTargetLabel("receiving-workspace.item")).toBeNull();
    expect(intentFromTargetLabel(null)).toBeNull();
  });

  it("names the live input in operator language", () => {
    expect(describeScanSource("camera")).toMatch(/camera/i);
    expect(describeScanSource("keyboard")).toMatch(/gun/i);
    expect(describeScanSource(null)).toMatch(/waiting/i);
  });
});

describe("scan outcome taxonomy", () => {
  it("separates accepted, duplicate, wrong-kind and unknown", () => {
    expect(classifyFeedback("ok", undefined)).toBe("accepted");
    expect(classifyFeedback("weighted", undefined)).toBe("accepted");
    expect(classifyFeedback("error", "Carton already loaded")).toBe("duplicate");
    expect(classifyFeedback("error", "That is a product barcode — scan a carton label instead.")).toBe(
      "wrong_kind",
    );
    expect(classifyFeedback("unknown", "No match")).toBe("unknown");
  });
});

describe("scanRouter change notification", () => {
  it("notifies subscribers on register and unregister", () => {
    const seen = vi.fn();
    const off = scanRouter.subscribe(seen);
    const unregister = scanRouter.register({ id: "t1", priority: 20, onScan: () => {}, label: "wms:pack.carton" });
    expect(seen).toHaveBeenCalledTimes(1);
    unregister();
    expect(seen).toHaveBeenCalledTimes(2);
    off();
    scanRouter.register({ id: "t2", priority: 20, onScan: () => {} });
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it("bumps the snapshot version so useSyncExternalStore re-reads", () => {
    const before = scanRouter.getStackVersion();
    const off = scanRouter.register({ id: "t3", priority: 20, onScan: () => {} });
    expect(scanRouter.getStackVersion()).toBeGreaterThan(before);
    off();
  });
});
