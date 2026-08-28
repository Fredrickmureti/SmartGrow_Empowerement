/**
 * Architecture guard — the platform shell must always expose a scope
 * switcher.
 *
 * Before 2026-08-28 the `PlatformShell` topbar rendered a read-only
 * `DeclaredScopeChip`, so migrated apps (Reports, …) had no way to change
 * company/branch — users had to navigate back to a legacy page that still
 * carried a `ScopeBadge`. These assertions stop that regressing.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("platform shell scope switcher", () => {
  const topbar = read("src/components/layout/shell/WorkspaceTopBar.tsx");
  const chip = read("src/components/common/ScopeSwitcherChip.tsx");
  const badge = read("src/components/common/ScopeBadge.tsx");

  it("WorkspaceTopBar renders the ScopeSwitcherChip", () => {
    expect(topbar).toMatch(/<ScopeSwitcherChip\b/);
    expect(topbar).toMatch(
      /import\s*\{\s*ScopeSwitcherChip\s*\}\s*from\s*"@\/components\/common\/ScopeSwitcherChip"/,
    );
  });

  it("WorkspaceTopBar no longer uses the read-only chip as the scope slot", () => {
    expect(topbar).not.toMatch(/<DeclaredScopeChip\b/);
  });

  it("the chip is not hidden on small screens", () => {
    expect(topbar).not.toMatch(/<ScopeSwitcherChip[^>]*hidden md:/);
  });

  it("ScopeSwitcherChip gates its trigger with useCanSwitchScope", () => {
    expect(chip).toMatch(/useCanSwitchScope\s*\(/);
    expect(chip).toMatch(/<ContextSwitcherSheet\b/);
  });

  it("ScopeSwitcherChip falls back to live business/branch context", () => {
    expect(chip).toMatch(/useBusinesses\s*\(/);
    expect(chip).toMatch(/useBranch\s*\(/);
  });

  it("ScopeBadge suppresses its inline trigger inside an app layout", () => {
    expect(badge).toMatch(/isInsideAppLayout/);
    expect(badge).toMatch(/shouldShowTrigger\s*=\s*canSwitch\s*&&\s*!isInsideAppLayout/);
  });
});
