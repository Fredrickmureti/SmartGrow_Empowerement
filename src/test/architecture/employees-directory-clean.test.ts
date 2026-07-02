/**
 * Architecture guards for the Employees directory page.
 *
 * 1. Page stays slim. Cap raised 600 → 660 in Wave H F6 to admit the
 *    server-side pagination plumbing (useEmployeesPaged + stats hook +
 *    IntersectionObserver sentinel + Select-all-matching). If you add
 *    another N lines, extract a hook instead of bumping the cap.
 * 2. Legacy `position` / `department` text columns must NOT be written
 *    by either the form submission or the import path.
 * 3. The setup-health surface must remain wired (verdict joined in
 *    server-side, pill rendered, filter chip present).
 * 4. The directory must NOT load the full employee list client-side
 *    (no `.range(0, 4999)` or equivalent on this page).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

function read(p: string) {
  return readFileSync(resolve(process.cwd(), p), "utf8");
}

describe("Employees directory architecture", () => {
  const src = read("src/pages/Employees.tsx");

  it("Employees.tsx stays bounded (≤ 660 lines)", () => {
    const lines = src.split("\n").length;
    expect(lines).toBeLessThanOrEqual(660);
  });

  it("does not write the legacy `position` text column", () => {
    expect(/\bposition:\s*null\b/.test(src)).toBe(false);
    expect(/\bposition:\s*form\./.test(src)).toBe(false);
  });

  it("does not write the legacy `department` text column", () => {
    expect(/\bdepartment:\s*null\b/.test(src)).toBe(false);
    expect(/\bdepartment:\s*form\./.test(src)).toBe(false);
  });

  it("uses the extracted directory subcomponents", () => {
    expect(src).toMatch(/from "@\/components\/employees\/directory\/CardGrid"/);
    expect(src).toMatch(/from "@\/components\/employees\/directory\/DesktopTable"/);
    expect(src).toMatch(/from "@\/components\/employees\/directory\/RowActions"/);
  });

  it("payload builder strips legacy columns", () => {
    const builder = read("src/lib/hr/buildEmployeePayload.ts");
    expect(/\bposition:\s/.test(builder)).toBe(false);
    expect(/\bdepartment:\s/.test(builder)).toBe(false);
    expect(/\bnhif_number:\s/.test(builder)).toBe(false);
  });

  it("wires the setup-health surface (verdict + filter + pill)", () => {
    expect(src).toMatch(/healthFilter/);
    expect(src).toMatch(/healthById/);
    // Verdict is now joined server-side via useEmployeesPaged.
    expect(src).toMatch(/health_verdict/);
    const pill = read("src/components/employees/directory/SetupHealthPill.tsx");
    expect(pill).toMatch(/SetupHealthPill/);
    const table = read("src/components/employees/directory/DesktopTable.tsx");
    expect(table).toMatch(/SetupHealthPill/);
  });

  it("uses server-side pagination (no full-list fetch on this page)", () => {
    expect(src).toMatch(/useEmployeesPaged/);
    expect(src).toMatch(/useEmployeeDirectoryStats/);
    // The shared full-list hook must be invoked with { enabled: false }
    // so this page does not re-fetch up to 5000 employees on mount.
    expect(src).toMatch(/useEmployees\(\{\s*enabled:\s*false\s*\}\)/);
    // No client-side range cap of 4999 on this page.
    expect(/\.range\(0,\s*4999\)/.test(src)).toBe(false);
  });
});
