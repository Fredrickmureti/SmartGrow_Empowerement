/**
 * Finance permission gating is TRI-STATE: loading / allowed / denied.
 *
 * A finance surface must never paint a "you lack permission" wall while the
 * permission answer (or the active company) is still resolving — that is what
 * produced the false red banners on Finance Settings. Denial UI is centralised
 * in <FinanceReadOnlyNotice>, which refuses to render while `isLoading`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const FINANCE_DIR = join(process.cwd(), "src/components/finance");

function financeFiles(): string[] {
  return readdirSync(FINANCE_DIR)
    .filter((f) => f.endsWith(".tsx"))
    .map((f) => join(FINANCE_DIR, f));
}

describe("finance permission gating", () => {
  it("never renders a raw destructive read-only permission banner", () => {
    const offenders: string[] = [];
    for (const file of financeFiles()) {
      const src = readFileSync(file, "utf8");
      if (/Read-only\s+—/.test(src) && /variant="destructive"/.test(src)) {
        offenders.push(file);
      }
    }
    expect(
      offenders,
      `Use <FinanceReadOnlyNotice> instead of a destructive alert in:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("FinanceReadOnlyNotice suppresses itself while loading", () => {
    const src = readFileSync(join(FINANCE_DIR, "FinanceReadOnlyNotice.tsx"), "utf8");
    expect(src).toMatch(/if\s*\(isLoading\s*\|\|\s*!readOnly\)\s*return null/);
  });

  it("useFinancePermission treats an unresolved company as loading, not denied", () => {
    const src = readFileSync(
      join(process.cwd(), "src/hooks/finance/useFinancePermission.ts"),
      "utf8",
    );
    expect(src).toMatch(/businessLoading/);
    expect(src).toMatch(/isReady/);
    // must be cached, not a bare per-mount RPC
    expect(src).toMatch(/staleTime/);
  });
});
