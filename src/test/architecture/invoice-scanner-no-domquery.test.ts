/**
 * Architecture guard — `InvoiceLineScanner` must not reach into the DOM
 * for focus. Refocus must go through the `BarcodeInputFieldHandle` ref.
 *
 * Regression motivation: an earlier implementation called
 * `document.querySelector('[data-invoice-line-scanner] input')` on every
 * scan, which raced Radix portals and fought toast/select focus traps.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

describe("InvoiceLineScanner — no document.querySelector for focus", () => {
  it("does not call document.querySelector or document.getElementById", () => {
    const src = readFileSync(
      resolve(process.cwd(), "src/components/invoices/InvoiceLineScanner.tsx"),
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
