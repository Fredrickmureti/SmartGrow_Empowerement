/**
 * Architecture guard — `scanner_device_trust` is RLS-restricted from
 * direct writes. All mutation MUST flow through the three security
 * definer RPCs (`scanner_issue_trust`, `scanner_reclaim_session`,
 * `scanner_revoke_trust`). This guard forbids any `src/` code from
 * calling `.insert() / .update() / .delete() / .upsert()` on the
 * `scanner_device_trust` table. `.select(...)` reads are allowed (the
 * admin Trusted-Devices panel needs them).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import path from "path";

const SRC = path.resolve(__dirname, "../..");
const SELF = __filename;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = path.join(dir, name);
    const s = statSync(full);
    if (s.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

const TARGET = "scanner_device_trust";
const FORBIDDEN = /\.(insert|update|delete|upsert)\s*\(/;

describe("scanner_device_trust client-write discipline", () => {
  it("no src/ file writes to scanner_device_trust directly — only RPCs", () => {
    const offenders: string[] = [];
    for (const f of walk(SRC)) {
      if (f === SELF) continue;
      const src = readFileSync(f, "utf8");
      // Quickly skip files that don't even mention the table name.
      if (!src.includes(TARGET)) continue;
      // Look for `.from("scanner_device_trust"` or `.from('scanner_device_trust'`
      // chained with a forbidden mutator within the same statement
      // (up to next `;` or end-of-call).
      const re = /\.from\s*\(\s*["']scanner_device_trust["'][^)]*\)([\s\S]{0,300}?);/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) {
        if (FORBIDDEN.test(m[1])) {
          offenders.push(`${path.relative(process.cwd(), f)} — ${m[0].slice(0, 120)}…`);
        }
      }
    }
    expect(
      offenders,
      `These files mutate scanner_device_trust directly instead of using scanner_issue_trust / scanner_reclaim_session / scanner_revoke_trust:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});