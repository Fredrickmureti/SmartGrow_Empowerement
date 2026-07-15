/**
 * Architecture guard: every top-level page under `src/pages/me/*` must
 * consume the platform design-system primitive `PageHeader` (or, for
 * detail children of an already-migrated parent, `RecordHeader`) rather
 * than hand-rolling its own `<h1>` block. This keeps the Employee
 * Self-Service portal visually and interactionally consistent with the
 * rest of the platform.
 *
 * See `docs/design-system/audit/ess-portal.md` for the surface-by-surface
 * status of the ESS consistency wave. The allow-list below tracks pages
 * that haven't been migrated yet — every entry there is a follow-up
 * ticket, not a permanent exemption.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const ME_DIR = resolve(__dirname, "../../pages/me");

/**
 * Pages that still hand-roll their own header. Each entry must have a
 * corresponding row in `docs/design-system/audit/ess-portal.md` marked
 * "Pending". Do not add new entries — migrate the page instead.
 */
const MIGRATION_TODO = new Set<string>([]);


describe("ESS portal uses the design-system PageHeader primitive", () => {
  const files = readdirSync(ME_DIR).filter((f) => f.endsWith(".tsx"));

  for (const file of files) {
    if (MIGRATION_TODO.has(file)) continue;
    it(`${file} imports PageHeader from @/design-system`, () => {
      const src = readFileSync(join(ME_DIR, file), "utf8");
      // Skip pure re-export shells.
      if (src.length < 400) return;
      expect(src).toMatch(/from\s+"@\/design-system"/);
      expect(src).toMatch(/PageHeader/);
      // Also disallow the hand-rolled sizing that this wave retired.
      expect(src).not.toMatch(/<h1[^>]*text-2xl[^>]*font-bold\s+tracking-tight/);
    });
  }

  it("MePortalLayout no longer renders the retired MeSubNav duplicate", () => {
    const src = readFileSync(
      resolve(__dirname, "../../components/me/MePortalLayout.tsx"),
      "utf8",
    );
    expect(src).not.toMatch(/MeSubNav/);
    expect(src).toMatch(/NAV_GROUPS/);
  });
});