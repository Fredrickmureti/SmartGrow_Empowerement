/**
 * Architecture test: nothing under src/pages/admin/ or src/components/admin/
 * may link to the tenant signup screen. Platform admins are invite-only
 * (see docs/adr/0004-platform-admin-vs-tenant.md). If a future change adds
 * such a link, this test fails the build.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function walk(dir: string, files: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return files;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, files);
    else if (/\.(ts|tsx)$/.test(entry)) files.push(full);
  }
  return files;
}

describe("admin tree must not link to tenant /signup", () => {
  it("contains no '/signup' references in admin pages or components", () => {
    const roots = ["src/pages/admin", "src/components/admin"];
    const offenders: string[] = [];
    for (const root of roots) {
      for (const file of walk(root)) {
        const content = readFileSync(file, "utf8");
        // Match `/signup` as a route literal but NOT `/admin-management/...`
        // and not the word "signup" inside identifiers like `signupForm`.
        const matches = content.match(/["'`]\/signup(?:[?#"'`/])/g);
        if (matches && matches.length > 0) {
          offenders.push(`${file}: ${matches.join(", ")}`);
        }
      }
    }
    expect(
      offenders,
      `Admin tree must not link to /signup (platform admins are invite-only). Offenders:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
