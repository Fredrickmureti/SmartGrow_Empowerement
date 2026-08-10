/**
 * Architecture guard — ONE approval & governance engine (ADR-0101).
 *
 * The system already ships a governance engine with multiple modes,
 * configured at /settings/workspace > Governance:
 *   governance_action_registry + approval_rules + approval_workflows
 *   + approval_requests/history, entered through approval_route /
 *   approval_decide (client: src/lib/governance/approvalEngine.ts).
 *
 * This test exists so that no future agent or engineer builds a second one.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const MIGRATIONS = join(ROOT, "supabase", "migrations");

function migrationBodies(): { file: string; body: string }[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => ({ file: f, body: readFileSync(join(MIGRATIONS, f), "utf8") }));
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const CANONICAL_TABLES = new Set([
  "approval_requests",
  "approval_request_steps",
  "approval_request_approvers",
  "approval_history",
  "approval_rules",
  "approval_rule_logs",
  "approval_workflows",
  "approval_workflow_steps",
  "governance_action_registry",
]);

describe("Governance — exactly one approval engine (ADR-0101)", () => {
  it("no migration introduces a parallel approval table", () => {
    const offenders: string[] = [];
    for (const { file, body } of migrationBodies()) {
      const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?public\.([a-z0-9_]+)/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(body))) {
        const table = m[1].toLowerCase();
        if (CANONICAL_TABLES.has(table)) continue;
        if (/(^|_)approval(s)?(_|$)/.test(table) && !/log|audit|history_/.test(table)) {
          offenders.push(`${file}: ${table}`);
        }
      }
    }
    expect(
      offenders,
      `A second approval engine is forbidden (ADR-0101). Register an action key in governance_action_registry instead. Offenders: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("only src/lib/governance holds an approval engine client module", () => {
    const offenders = walk(join(ROOT, "src"))
      .map((f) => f.slice(ROOT.length + 1))
      .filter((rel) => /approvalengine/i.test(rel))
      .filter((rel) => !rel.startsWith(join("src", "lib", "governance")));
    expect(
      offenders,
      `The only approval engine client is src/lib/governance/approvalEngine.ts. Offenders: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("RFQ approval is routed through the canonical engine", () => {
    const bodies = migrationBodies().map((m) => m.body);
    const submit = bodies.filter((b) =>
      b.includes("CREATE OR REPLACE FUNCTION public.rfq_submit_for_approval"),
    );
    expect(submit.length).toBeGreaterThan(0);
    const latestSubmit = submit[submit.length - 1];
    expect(latestSubmit).toMatch(/approval_route\(\s*\n?\s*'rfq\.approve'/);

    const approve = bodies.filter((b) =>
      b.includes("CREATE OR REPLACE FUNCTION public.rfq_approve"),
    );
    const latestApprove = approve[approve.length - 1];
    expect(latestApprove).toMatch(/GOV_USE_APPROVAL_ENGINE/);

    const mirror = bodies.filter((b) => b.includes("_mirror_approval_to_rfq"));
    expect(mirror.length).toBeGreaterThan(0);
  });

  it("the ADR that forbids a second engine is present", () => {
    const adr = readFileSync(
      join(ROOT, "docs", "adr", "ADR-0101-single-governance-approval-engine.md"),
      "utf8",
    );
    expect(adr).toMatch(/exactly ONE approval/i);
  });
});
