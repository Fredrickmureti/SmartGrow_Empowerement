/**
 * Architecture guard — `DocumentLineScanner` must not reach into the DOM
 * for focus. Refocus must go through the `BarcodeInputFieldHandle` ref.
 *
 * Regression motivation: an earlier implementation queried the DOM for the
 * scanner input on every scan, which raced Radix portals and fought
 * toast/select focus traps.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

describe("DocumentLineScanner — no DOM queries for focus", () => {
  it("does not call document.querySelector or document.getElementById", () => {
    const src = readFileSync(
      resolve(process.cwd(), "src/components/documents/lines/DocumentLineScanner.tsx"),
      "utf8",
    );
    // Strip line/block comments before scanning so docs can mention the
    // banned APIs without tripping the guard.
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(stripped).not.toMatch(/document\.querySelector/);
    expect(stripped).not.toMatch(/document\.getElementById/);
  });
});
