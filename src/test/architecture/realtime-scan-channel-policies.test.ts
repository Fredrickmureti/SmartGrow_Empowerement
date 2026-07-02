/**
 * Architecture guard: the realtime channels that carry phone-as-scanner
 * traffic MUST stay gated on `can_access_*` helpers, on BOTH the SELECT
 * (USING) and INSERT (WITH CHECK) policies. A regression here would let
 * any authenticated user subscribe to or broadcast on another tenant's
 * scanner topic.
 *
 * Same last-definition-wins migration-history scan as
 * `pgcrypto-extension-prefix.test.ts`.
 *
 * The expected topic families:
 *   - `pos:scan:%`      → gated by `can_access_pos_scan_channel(realtime.topic())`
 *   - `scan:session:%`  → gated by `can_access_scan_channel(realtime.topic())`
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");

interface PolicyBlock {
  file: string;
  name: string;
  cmd: string; // SELECT | INSERT | UPDATE | DELETE | ALL
  expr: string; // USING(...) for SELECT, WITH CHECK(...) for INSERT
}

const POLICY_NAME_RE =
  /CREATE\s+POLICY\s+"?([a-zA-Z0-9_]+)"?\s+ON\s+realtime\.messages([\s\S]*?);/gi;

function extractRealtimePolicies(file: string, sql: string): PolicyBlock[] {
  const out: PolicyBlock[] = [];
  let m: RegExpExecArray | null;
  POLICY_NAME_RE.lastIndex = 0;
  while ((m = POLICY_NAME_RE.exec(sql)) !== null) {
    const name = m[1];
    const body = m[2];
    const cmdMatch = body.match(/FOR\s+(SELECT|INSERT|UPDATE|DELETE|ALL)/i);
    const cmd = (cmdMatch?.[1] ?? "ALL").toUpperCase();
    let expr = "";
    if (cmd === "SELECT" || cmd === "ALL") {
      const u = body.match(/USING\s*\(([\s\S]*?)\)\s*(?:WITH\s+CHECK|;|$)/i);
      if (u) expr = u[1];
    }
    if (!expr && (cmd === "INSERT" || cmd === "UPDATE" || cmd === "ALL")) {
      const w = body.match(/WITH\s+CHECK\s*\(([\s\S]*?)\)\s*;?\s*$/i);
      if (w) expr = w[1];
    }
    out.push({ file, name, cmd, expr });
  }
  return out;
}

function isScanPolicy(p: PolicyBlock): boolean {
  return (
    /scan/i.test(p.name) ||
    /pos:scan:/i.test(p.expr) ||
    /scan:session:/i.test(p.expr)
  );
}

function isGated(expr: string): boolean {
  return (
    /can_access_pos_scan_channel\s*\(/i.test(expr) ||
    /can_access_scan_channel\s*\(/i.test(expr)
  );
}

describe("realtime scan-channel policy guard", () => {
  it("every scan-related policy on realtime.messages stays gated on can_access_*", () => {
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    // Last definition of each policy name wins.
    const lastDef = new Map<string, PolicyBlock>();
    for (const f of files) {
      const sql = readFileSync(join(MIGRATIONS_DIR, f), "utf-8");
      // DROP POLICY removes the policy entirely from "expected current shape".
      const dropRe =
        /DROP\s+POLICY\s+(?:IF\s+EXISTS\s+)?"?([a-zA-Z0-9_]+)"?\s+ON\s+realtime\.messages/gi;
      let dm: RegExpExecArray | null;
      while ((dm = dropRe.exec(sql)) !== null) lastDef.delete(dm[1]);
      for (const p of extractRealtimePolicies(f, sql)) lastDef.set(p.name, p);
    }

    const scanPolicies = [...lastDef.values()].filter(isScanPolicy);
    expect(
      scanPolicies.length,
      "no scan-channel policies were found in migrations — did a refactor delete them?",
    ).toBeGreaterThan(0);

    const violations: PolicyBlock[] = [];
    for (const p of scanPolicies) {
      if (!isGated(p.expr)) violations.push(p);
    }

    if (violations.length > 0) {
      const formatted = violations
        .map(
          (v) =>
            `  ${v.file}  policy=${v.name}  cmd=${v.cmd}  expr=${v.expr.trim().slice(0, 120)}`,
        )
        .join("\n");
      throw new Error(
        `Found ${violations.length} scan-channel policy(ies) on realtime.messages whose ` +
          `latest definition is NOT gated on can_access_pos_scan_channel(...) or ` +
          `can_access_scan_channel(...). This would expose another tenant's phone-as-scanner ` +
          `traffic. Re-add the gate:\n${formatted}`,
      );
    }
    expect(violations.length).toBe(0);
  });
});
