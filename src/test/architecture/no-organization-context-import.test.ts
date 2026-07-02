/**
 * Architecture guard test — forbids imports from the deleted
 * `@/contexts/OrganizationContext` module.
 *
 * The Organization context was a duplicate pass-through wrapper around
 * SessionContext. It has been removed so there is exactly one source of
 * truth for org/workspace data. All consumers must import from
 * `@/hooks/useOrganization` instead.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep, posix } from "node:path";

const SCOPES = ["src"];

const FORBIDDEN = /from\s+["']@\/contexts\/OrganizationContext["']/;

function walk(dir: string): string[] {
  const out: string[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

function toPosix(p: string): string {
  return p.split(sep).join(posix.sep);
}

describe("architecture: legacy OrganizationContext is deleted", () => {
  for (const scope of SCOPES) {
    it(`${scope} contains no imports from @/contexts/OrganizationContext`, () => {
      const files = walk(scope);
      const offenders: string[] = [];
      for (const f of files) {
        // Allow this test file to mention the path as a string literal.
        if (
          f.endsWith(
            ["src", "test", "architecture", "no-organization-context-import.test.ts"].join(sep),
          )
        )
          continue;
        const src = readFileSync(f, "utf8");
        if (FORBIDDEN.test(src)) offenders.push(toPosix(f));
      }
      expect(
        offenders,
        `Import @/hooks/useOrganization instead. Offenders:\n${offenders.join("\n")}`,
      ).toEqual([]);
    });
  }
});
