/**
 * Architecture guard test — every CRM hook touching a business-scoped table
 * must filter by `business_id` AND by `organization_id`.
 *
 * Without the `business_id` filter, a workspace with two companies will see
 * Company A's leads, activities, lost reasons, etc. on Company B's screens.
 * The DB layer enforces a `business_id` column on every CRM table; the test
 * here enforces that the application code actually uses it.
 *
 * Tables we audit:
 *   - leads
 *   - crm_activities
 *   - crm_activity_types
 *   - crm_lost_reasons
 *   - crm_stages
 */
import { describe, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep, posix } from "node:path";
import { expect } from "vitest";

const SCOPE = "src/hooks/crm";
const TABLES = [
  "leads",
  "crm_activities",
  "crm_activity_types",
  "crm_lost_reasons",
  "crm_stages",
];

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

/**
 * For each `.from("<table>")` call inside the file source, take a 800-char
 * window starting at the call. Within that window we expect to see both
 * `.eq("organization_id"` and `.eq("business_id"` (single-quotes accepted too).
 *
 * We intentionally use a generous window because chained Supabase queries can
 * span several lines; if both filters are NOT present in the same chain, that
 * is the leak we want to fail on.
 */
function findUnscopedQueries(src: string, table: string): string[] {
  const offenders: string[] = [];
  const fromRegex = new RegExp(`\\.from\\(\\s*["']${table}["']\\s*\\)`, "g");
  let match: RegExpExecArray | null;
  while ((match = fromRegex.exec(src)) !== null) {
    const window = src.slice(match.index, match.index + 800);
    const hasOrgEq = /\.eq\(\s*["']organization_id["']/.test(window);
    const hasBizEq = /\.eq\(\s*["']business_id["']/.test(window);
    // `.match({ organization_id: ..., business_id: ... })` is semantically
    // equivalent to two `.eq()` chains and is accepted as a valid scope.
    // The match() call may take an inline object literal OR a variable
    // assembled just before the chain (e.g. `const filters = { ... }`).
    const matchBlock = window.match(/\.match\(\s*\{[\s\S]*?\}\s*\)/);
    const hasOrgMatch = matchBlock ? /organization_id\s*:/.test(matchBlock[0]) : false;
    const hasBizMatch = matchBlock ? /business_id\s*:/.test(matchBlock[0]) : false;
    // `.match(<identifier>)` — look at the 1500 chars before the .from() for
    // a `<identifier> = { ... organization_id ... business_id ... }` block.
    const matchVarRef = window.match(/\.match\(\s*([A-Za-z_$][\w$]*)\s*\)/);
    const beforeForMatch = src.slice(Math.max(0, match.index - 1500), match.index);
    const matchVarStamped = matchVarRef
      ? new RegExp(`${matchVarRef[1]}\\s*=\\s*\\{[\\s\\S]*?organization_id[\\s\\S]*?business_id`).test(beforeForMatch)
      : false;
    // Writes targeting a single row by primary key (`.eq("id", X)`) are
    // legitimate — RLS still enforces tenant + business isolation, and the
    // PK lookup can't possibly hit the wrong company's row.
    const isPkTargeted = /\.eq\(\s*["']id["']/.test(window) || /\.match\(\s*\{[\s\S]*?\bid\s*:/.test(window);
    // `.insert(payload)` where the payload literal carries both keys is
    // also acceptable — a stamping write that pins both scopes on the row.
    // We look in a wider window before AND after the .from() to find the
    // assembled payload variable (e.g. `const insertData = { ... }`).
    const before = src.slice(Math.max(0, match.index - 1500), match.index);
    const wideWindow = before + window;
    const isInsert = /\.insert\(/.test(window);
    const hasOrgInPayload = /organization_id\s*:/.test(wideWindow);
    const hasBizInPayload = /business_id\s*:/.test(wideWindow);
    const insertStamped = isInsert && hasOrgInPayload && hasBizInPayload;
    const hasOrg = hasOrgEq || hasOrgMatch || matchVarStamped || isPkTargeted || insertStamped;
    const hasBiz = hasBizEq || hasBizMatch || matchVarStamped || isPkTargeted || insertStamped;
    if (!(hasOrg && hasBiz)) {
      offenders.push(`from("${table}") at offset ${match.index} — orgFilter=${hasOrg} bizFilter=${hasBiz}`);
    }
  }
  return offenders;
}

describe("architecture: CRM hooks must filter by business_id", () => {
  const files = walk(SCOPE);
  for (const f of files) {
    it(`${toPosix(f)} scopes every CRM query by org + business`, () => {
      const src = readFileSync(f, "utf8");
      const allOffenders: string[] = [];
      for (const table of TABLES) {
        for (const o of findUnscopedQueries(src, table)) {
          allOffenders.push(o);
        }
      }
      expect(
        allOffenders,
        `CRM queries must include both organization_id and business_id filters in the SAME chain.\nOffenders in ${toPosix(f)}:\n${allOffenders.join("\n")}`,
      ).toEqual([]);
    });
  }
});
