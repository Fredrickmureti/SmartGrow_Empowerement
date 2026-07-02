/**
 * Architecture guard: lead → estimate / sales_order / project conversions
 * must go through the idempotent SECURITY DEFINER RPCs
 * (convert_lead_to_estimate / convert_lead_to_sales_order /
 * convert_lead_to_project). The client-side fallback used to create
 * duplicate downstream documents on retries; this test prevents it from
 * being re-introduced.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(process.cwd(), "src");
const ALLOWLIST_BASENAMES = new Set([
  // The hook is the only place that knows about source_lead_id at write time
  // for the lead→{estimate,sales_order,project} chain; it calls the RPCs.
  "useLeads.ts",
  // Generic project hook accepts an optional source_lead_id when callers
  // already have one (e.g. importers, direct API). Lead conversion path
  // goes through convert_lead_to_project RPC, not this hook.
  "useProjects.ts",
]);


function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) walk(full, acc);
    else if (/\.(ts|tsx)$/.test(entry)) acc.push(full);
  }
  return acc;
}

describe("crm: no client-side lead conversion writes", () => {
  it("does not insert into estimates/sales_orders/projects with source_lead_id outside useLeads.ts", () => {
    const files = walk(ROOT).filter((f) => !/\.test\.(ts|tsx)$/.test(f));
    const offenders: string[] = [];

    for (const f of files) {
      const base = f.split("/").pop()!;
      if (ALLOWLIST_BASENAMES.has(base)) continue;
      const src = readFileSync(f, "utf8");
      // Heuristic: any direct write that names source_lead_id near an insert.
      if (
        /source_lead_id\s*:/.test(src) &&
        /\.from\(["'](?:estimates|sales_orders|projects)["']\)/.test(src) &&
        /\.insert\(/.test(src)
      ) {
        offenders.push(relative(process.cwd(), f));
      }
    }

    expect(offenders, `Use the convert_lead_to_* RPCs instead:\n${offenders.join("\n")}`).toEqual([]);
  });
});
