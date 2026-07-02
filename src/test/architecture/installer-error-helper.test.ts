/**
 * Architecture guard — the literal toast string
 * "Failed to install localization pack" MUST only appear inside the
 * shared `formatInstallerError` helper. All other call sites must
 * surface the structured edge-function body via the helper so users
 * see the real cause (PAYROLL_NOT_INSTALLED, INSTALL_CHECK_VIOLATION,
 * step + sqlstate, etc.) instead of a generic failure.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { globSync } from "glob";

const HELPER_PATH = "src/features/localization/lib/installerError.ts";
const LITERAL = "Failed to install localization pack";

describe("formatInstallerError sole-owner rule", () => {
  it("literal toast string only appears in the helper", () => {
    const files = globSync("src/**/*.{ts,tsx}", {
      ignore: ["src/**/*.test.ts", "src/**/*.test.tsx", "src/test/**"],
    });
    const offenders = files.filter((f) => {
      if (f === HELPER_PATH) return false;
      const src = readFileSync(f, "utf8");
      return src.includes(LITERAL);
    });
    expect(offenders).toEqual([]);
  });
});
