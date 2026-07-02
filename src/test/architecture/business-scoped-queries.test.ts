/**
 * Architecture guard — every Supabase query against a business-scoped table
 * must filter by BOTH `organization_id` AND `business_id` in the same chain.
 *
 * Without `business_id`, a workspace with two Companies leaks Company A's
 * data onto Company B's screens and contaminates the books. The DB-side
 * RLS now enforces `user_can_access_business(business_id)` (Phase A), but
 * we still need application-level filters to prevent over-fetching and to
 * make `business_id` mandatory in inserts.
 *
 * Allow-list: place a comment within 200 chars BEFORE a `.from(...)` call
 * containing the marker `SCOPE-EXEMPT:` followed by a short reason. The
 * test will skip that call site. Use sparingly — only for genuine
 * cross-company tooling (consolidation, admin audit-log review, migration
 * sessions that are themselves the workspace boundary).
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep, posix } from "node:path";
import { BUSINESS_SCOPED_TABLES } from "@/lib/businessScopedTables";

const SCOPE_DIRS = ["src/hooks", "src/components", "src/pages", "src/lib", "src/services"];
const EXEMPT_MARKER = "SCOPE-EXEMPT:";

function walk(dir: string): string[] {
  const out: string[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === "dist") continue;
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !p.includes(`${sep}__tests__${sep}`) && !p.includes(`${sep}test${sep}`)) {
      out.push(p);
    }
  }
  return out;
}

function toPosix(p: string): string {
  return p.split(sep).join(posix.sep);
}

interface Offender {
  file: string;
  table: string;
  offset: number;
}

function findOffendersInFile(file: string): Offender[] {
  const src = readFileSync(file, "utf8");
  const offenders: Offender[] = [];
  for (const table of BUSINESS_SCOPED_TABLES) {
    const re = new RegExp(`\\.from\\(\\s*["']${table}["']\\s*\\)`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      // Limit the window to the current Supabase query chain — stop at the
      // next `.from(` call or at the end of the awaited expression so we
      // don't credit a sibling query's filters to this one.
      const fullWin = src.slice(m.index, m.index + 1500);
      const nextFrom = fullWin.indexOf(".from(", 2);
      const win = nextFrom > 0 ? fullWin.slice(0, nextFrom) : fullWin;
      const hasOrg = /\.eq\(\s*["']organization_id["']/.test(win);
      const hasBiz = /\.eq\(\s*["']business_id["']/.test(win);
      // Accept the shared-account pattern: .or("business_id.eq.<id>,business_id.is.null")
      const hasBizOr = /\.or\(\s*[`"'][^`"']*business_id\.eq\.[^`"']*business_id\.is\.null/.test(win)
        || /business_id\.is\.null[^`"']*business_id\.eq\./.test(win);
      if (!hasOrg) continue; // pure id-based op (insert/update by pk) is fine
      if (hasBiz || hasBizOr) continue;
      const before = src.slice(Math.max(0, m.index - 200), m.index);
      if (before.includes(EXEMPT_MARKER)) continue;
      offenders.push({ file, table, offset: m.index });
    }
  }
  return offenders;
}

const allFiles = SCOPE_DIRS.flatMap(walk);
const allOffenders = allFiles.flatMap(findOffendersInFile);

describe("architecture: business-scoped query isolation", () => {
  it("every query against a business-scoped table must filter by business_id", () => {
    if (allOffenders.length > 0) {
      const grouped: Record<string, Offender[]> = {};
      for (const o of allOffenders) (grouped[o.file] ??= []).push(o);
      const summary = Object.entries(grouped)
        .map(([f, list]) => `  ${toPosix(f)} (${list.length}): ${list.map((x) => x.table).join(", ")}`)
        .join("\n");
      throw new Error(
        `[arch-guard] ${allOffenders.length} unscoped business-table queries across ${Object.keys(grouped).length} files:\n${summary}\n\n` +
        `Add .eq("business_id", currentBusiness.id) to the query chain, or precede the .from(...) ` +
        `call with a // SCOPE-EXEMPT: <reason> comment if cross-company access is intentional.`,
      );
    }
    expect(allOffenders.length).toBe(0);
  });
});