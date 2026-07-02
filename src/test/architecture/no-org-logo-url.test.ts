/**
 * Architecture guard — fails CI if any source file references the
 * dropped `organizations.logo_url` column, or selects it from `o.logo_url`
 * in any new SQL/RPC body shipped via TS.
 *
 * Background: `organizations.logo_url` was deprecated (the per-company
 * logo lives on `businesses.logo_url`, Odoo res.company-style). A prior
 * RPC still SELECTed `o.logo_url` and broke every authenticated session
 * with a 42703 error. This guard prevents that regression.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SCOPES = ["src", "supabase/functions"];

// Allow historical migration files (they ran once; rewriting them is harmful).
// The guard scans the live codebase and edge functions.
const FORBIDDEN_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  // .from('organizations').select('… logo_url …') — same statement, ≤200 chars apart
  {
    pattern: /\.from\(\s*["'`]organizations["'`]\s*\)[\s\S]{0,200}?\.select\([^)]*logo_url/,
    reason: ".from('organizations').select(... logo_url ...)",
  },
  // SQL inside template literals: "FROM organizations o … o.logo_url"
  // Require the literal `organizations o` alias and `o.logo_url` within ~300 chars.
  {
    pattern: /\borganizations\s+o\b[\s\S]{0,300}?\bo\.logo_url\b/i,
    reason: "SQL: FROM organizations o ... o.logo_url",
  },
  // Dotted column reference (covers most direct refs).
  {
    pattern: /\borganizations\.logo_url\b/,
    reason: "organizations.logo_url",
  },
];

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === ".git") continue;
    const full = join(dir, entry);
    let s: ReturnType<typeof statSync>;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      walk(full, out);
    } else if (/\.(ts|tsx|js|jsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe("no-org-logo-url architecture guard", () => {
  it("no source file references the dropped organizations.logo_url column", () => {
    const offenders: string[] = [];
    for (const scope of SCOPES) {
      for (const file of walk(scope)) {
        // Allow this guard file itself + the integration types file
        // (which has historical type entries auto-generated from past schema).
        if (file.endsWith("no-org-logo-url.test.ts")) continue;
        if (file.endsWith("integrations/supabase/types.ts")) continue;
        const src = readFileSync(file, "utf8");
        for (const { pattern, reason } of FORBIDDEN_PATTERNS) {
          if (pattern.test(src)) {
            offenders.push(`${file}  ::  ${reason}`);
            break;
          }
        }
      }
    }
    if (offenders.length > 0) {
      throw new Error(
        `Found references to organizations.logo_url (column was dropped — use businesses.logo_url):\n` +
          offenders.join("\n"),
      );
    }
    expect(offenders).toEqual([]);
  });
});
