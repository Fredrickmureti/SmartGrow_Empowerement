/**
 * Schema-drift guard for CRM edge-function consumers.
 *
 * Three backend consumers (automation, scheduled reports, AI assistant) broke
 * silently when `crm_leads.company_name` and `crm_leads.stage` were removed:
 * nothing tied their hand-written queries to the CRM schema. This test walks
 * every `crm_*` select/insert in those functions and fails when a referenced
 * column no longer exists in the generated Supabase types.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const TYPES_FILE = "src/integrations/supabase/types.ts";
const CONSUMERS = [
  "supabase/functions/process-automation/index.ts",
  "supabase/functions/process-scheduled-reports/index.ts",
  "supabase/functions/ai-assistant/index.ts",
];

/** Row column names per table, read from the generated types file. */
function readSchema(): Map<string, Set<string>> {
  const src = readFileSync(TYPES_FILE, "utf8");
  const schema = new Map<string, Set<string>>();
  const tableRe = /^ {6}(crm_[a-z0-9_]+): \{$/gm;
  let m: RegExpExecArray | null;
  while ((m = tableRe.exec(src))) {
    const rowStart = src.indexOf("Row: {", m.index);
    if (rowStart === -1) continue;
    const rowEnd = src.indexOf("\n        }", rowStart);
    const block = src.slice(rowStart, rowEnd);
    const cols = new Set<string>();
    for (const line of block.split("\n").slice(1)) {
      const c = line.match(/^\s{10}([a-z0-9_]+)(\?)?:/);
      if (c) cols.add(c[1]);
    }
    schema.set(m[1], cols);
  }
  return schema;
}

/** `.from("crm_x").select("a, b, rel(c)")` → { table, columns } */
function selectRefs(code: string): { table: string; columns: string[] }[] {
  const out: { table: string; columns: string[] }[] = [];
  const re = /\.from\(\s*"(crm_[a-z0-9_]+)"\s*\)[\s\S]{0,200}?\.select\(\s*(?:"([^"]*)"|`([^`]*)`)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    const raw = (m[2] ?? m[3] ?? "").replace(/\s+/g, " ");
    // Drop embedded relations — their columns belong to the related table.
    const flat = raw.replace(/[a-z0-9_]+\s*:?\s*[a-z0-9_]*\([^)]*\)/g, "");
    const columns = flat
      .split(",")
      .map(c => c.trim())
      .filter(c => c.length > 0 && c !== "*" && /^[a-z0-9_]+$/.test(c));
    out.push({ table: m[1], columns });
  }
  return out;
}

/** `.from("crm_x").insert({ a: …, b: … })` → { table, columns } */
function insertRefs(code: string): { table: string; columns: string[] }[] {
  const out: { table: string; columns: string[] }[] = [];
  const re = /\.from\(\s*"(crm_[a-z0-9_]+)"\s*\)\s*\.insert\(\s*\{([\s\S]*?)\n\s*\}\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    const columns = [...m[2].matchAll(/(?:^|\n)\s*([a-z0-9_]+)\s*:/g)].map(k => k[1]);
    out.push({ table: m[1], columns });
  }
  return out;
}

describe("CRM edge-function consumers match the CRM schema", () => {
  const schema = readSchema();

  it("knows the CRM tables from the generated types", () => {
    expect(schema.get("crm_leads")?.size).toBeGreaterThan(10);
    expect(schema.get("crm_activities")?.size).toBeGreaterThan(5);
  });

  for (const file of CONSUMERS) {
    it(`${file} references only existing CRM columns`, () => {
      const code = readFileSync(file, "utf8");
      const refs = [...selectRefs(code), ...insertRefs(code)];
      const problems: string[] = [];
      for (const { table, columns } of refs) {
        const cols = schema.get(table);
        if (!cols) {
          problems.push(`unknown table ${table}`);
          continue;
        }
        for (const c of columns) {
          if (!cols.has(c)) problems.push(`${table}.${c}`);
        }
      }
      expect(problems, `stale CRM column references in ${file}: ${problems.join(", ")}`).toEqual([]);
    });
  }

  it("automation always supplies the mandatory scope columns on crm_activities", () => {
    const code = readFileSync("supabase/functions/process-automation/index.ts", "utf8");
    for (const { table, columns } of insertRefs(code)) {
      if (table !== "crm_activities") continue;
      expect(columns, "crm_activities.business_id is NOT NULL").toContain("business_id");
      expect(columns).toContain("organization_id");
    }
  });
});
