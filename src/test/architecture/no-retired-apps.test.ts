/**
 * Architecture guard — retired apps must not reappear in source.
 *
 * If you intentionally re-introduce one of these ids, remove it from
 * RETIRED_APP_IDS. Otherwise this test catches accidental resurrection
 * via copy/paste, AI suggestions, or stale rebases.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const RETIRED_APP_IDS = ["documents", "sign", "spreadsheets"] as const;

// Directories where retired ids are *allowed* (historical artifacts, or
// legitimate sub-modules of surviving apps — e.g. Projects has a
// "documents" sub-module at /projects-app/documents).
const ALLOW_PATH_PREFIXES = [
  "supabase/migrations/",
  "docs/",
  "src/test/architecture/no-retired-apps.test.ts",
  "src/integrations/supabase/types.ts",
  "src/lib/apps/registry.ts",        // Projects sub-module named "documents"
  "src/apps/projects/",               // Projects routes use "documents" sub-path
  "src/apps/hr/",                     // HR routes redirect to /me/documents
  "src/apps/me/",                     // Me app has a documents tab
];

// Scope: only files that participate in app/module registration. Webhook
// signature code, Web Crypto key-usage arrays (`["sign"]`), and similar
// generic uses of the bare strings are not app-id references.
const ROOTS = ["src/lib/apps", "src/apps", "src/pages/admin"];


function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) {
      if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
      walk(p, out);
    } else if (/\.(ts|tsx|js|jsx|sql|md)$/.test(entry)) {
      out.push(p);
    }
  }
  return out;
}

// Match an id only when it appears as a quoted string literal (an app-id).
// This avoids false positives like `signature`, `signin`, `documentTitle`.
function makeAppIdRegex(id: string): RegExp {
  return new RegExp(`['"\`]${id}['"\`]`);
}

describe("Retired apps do not leak into source", () => {
  const files = ROOTS.flatMap((r) => {
    try {
      return walk(r);
    } catch {
      return [];
    }
  });

  for (const id of RETIRED_APP_IDS) {
    it(`no source file references the retired app id "${id}"`, () => {
      const re = makeAppIdRegex(id);
      const offenders: string[] = [];
      for (const file of files) {
        if (ALLOW_PATH_PREFIXES.some((prefix) => file.startsWith(prefix))) continue;
        const content = readFileSync(file, "utf8");
        if (re.test(content)) offenders.push(file);
      }
      expect(offenders, `Retired app id "${id}" found in:\n${offenders.join("\n")}`).toEqual([]);
    });
  }
});
