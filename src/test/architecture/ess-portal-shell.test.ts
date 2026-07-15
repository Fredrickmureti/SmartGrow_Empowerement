/**
 * ESS portal shell integrity — belt-and-braces companion to the ESLint
 * rule `no-shell-leak-from-me`. Fails CI if any file under
 * `src/pages/me/**` or `src/apps/me/**` links or navigates into the
 * admin shells (`/hr/*`, `/settings/*`, `/notifications`) outside the
 * documented manager drill-down allowlist.
 *
 * Why both? ESLint may skip files when the CI cache is warm; a direct
 * filesystem sweep catches leaks even then.
 */
import { readFileSync } from "node:fs";
import { globSync } from "glob";
import { describe, it, expect } from "vitest";

const ALLOWLIST = [
  "/hr/talent/reviews",
  "/hr/talent/development",
];

const BLOCKED = [
  /to\s*=\s*["'`]\/hr\/[^"'`]+["'`]/g,
  /to\s*=\s*["'`]\/settings\/[^"'`]+["'`]/g,
  /to\s*=\s*["'`]\/notifications(?:["'`?\/])/g,
  /navigate\(\s*["'`]\/hr\/[^"'`]+["'`]/g,
  /navigate\(\s*["'`]\/settings\/[^"'`]+["'`]/g,
  /navigate\(\s*["'`]\/notifications(?:["'`?\/])/g,
];

function isAllowed(match: string): boolean {
  return ALLOWLIST.some((p) => match.includes(p));
}

describe("ESS portal shell integrity", () => {
  it("no /me/* file links or navigates into /hr, /settings, or /notifications shells", () => {
    const files = globSync("src/{pages,apps}/me/**/*.{ts,tsx}", { absolute: false });
    const violations: string[] = [];

    for (const file of files) {
      const src = readFileSync(file, "utf8");
      for (const re of BLOCKED) {
        for (const m of src.matchAll(re)) {
          if (!isAllowed(m[0])) {
            violations.push(`${file}: ${m[0]}`);
          }
        }
      }
    }

    expect(violations, `Portal shell leak:\n${violations.join("\n")}`).toEqual([]);
  });
});
