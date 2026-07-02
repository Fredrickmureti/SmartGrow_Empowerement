import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CANONICAL_SECTIONS,
  LEGACY_SECTION_REDIRECTS,
} from "../../lib/hr/legacyProfileSections";

/**
 * Stage-4 lock + Wave G consolidation.
 *
 * The profile must remain a sidebar hub (no horizontal Tabs bar) and the
 * sidebar must stay at the 12 canonical sections — every legacy `?section=`
 * key from earlier waves must remain reachable via the redirect map so no
 * external deep link rots.
 */
const PROFILE = resolve(__dirname, "../../pages/hr/EmployeeProfile.tsx");
const SIDEBAR = resolve(__dirname, "../../components/employees/profile/ProfileSidebar.tsx");
const OVERVIEW = resolve(__dirname, "../../components/employees/profile/OverviewSection.tsx");

describe("Employee profile hub", () => {
  const src = readFileSync(PROFILE, "utf8");

  it("does not render TabsTrigger at the top level (sidebar nav, not tabs)", () => {
    // Sub-section tabs (Contracts, Benefits) are allowed inside section
    // components, but the profile page itself must not declare any.
    expect(src).not.toMatch(/TabsTrigger/);
  });

  it("imports the ProfileSidebar component", () => {
    expect(src).toMatch(/ProfileSidebar/);
  });

  it("renders the OverviewSection as the default landing pane", () => {
    expect(src).toMatch(/OverviewSection/);
    expect(src).toMatch(/section.*overview/);
  });

  it("persists active section to ?section= URL param", () => {
    expect(src).toMatch(/useSearchParams/);
    expect(src).toMatch(/searchParams\.get\("section"\)/);
  });

  it("gates Payroll section behind viewPayroll permission", () => {
    expect(src).toMatch(/canViewPayroll.*payroll|payroll.*canViewPayroll/s);
  });

  it("ProfileSidebar and OverviewSection components exist", () => {
    expect(() => readFileSync(SIDEBAR, "utf8")).not.toThrow();
    expect(() => readFileSync(OVERVIEW, "utf8")).not.toThrow();
  });

  it("exposes exactly 13 canonical sections (12 sidebar + activity log)", () => {
    // 13 keys: 3 main + 7 hr + 3 admin. The visible-to-HR-manager count is
    // 12 because Private is the only "main" item gated by permission, but
    // the canonical set must stay stable so the redirect map can target
    // them without drifting.
    expect(CANONICAL_SECTIONS).toHaveLength(13);
  });

  it("never re-introduces the removed standalone sidebar items", () => {
    // These keys MUST NOT reappear as top-level sidebar items. They are
    // either folded into another section (loans/assets/compensation) or
    // moved off the sidebar entirely (hr_settings → header overflow).
    const removed = ["loans", "assets", "compensation", "hr_settings"];
    for (const key of removed) {
      expect(CANONICAL_SECTIONS as readonly string[]).not.toContain(key);
    }
  });

  it("every removed key is covered by the legacy redirect map", () => {
    const removed = ["loans", "assets", "compensation", "hr_settings"];
    for (const key of removed) {
      expect(LEGACY_SECTION_REDIRECTS[key], `${key} must redirect somewhere`).toBeDefined();
      const target = LEGACY_SECTION_REDIRECTS[key].section;
      expect(CANONICAL_SECTIONS as readonly string[]).toContain(target);
    }
  });

  it("profile page imports and consumes the legacy redirect map", () => {
    expect(src).toMatch(/LEGACY_SECTION_REDIRECTS/);
  });

  it("profile page wires the HR Settings overflow trigger", () => {
    // HR Settings is not a sidebar item anymore; it must still be reachable
    // via the header's `onOpenHrSettings` prop.
    expect(src).toMatch(/onOpenHrSettings/);
  });
});
