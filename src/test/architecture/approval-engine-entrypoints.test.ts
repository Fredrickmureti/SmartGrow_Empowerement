/**
 * Phase 3 architecture guard — Approval engine single entry points.
 *
 * Enforces:
 *  1. The migration defines the two canonical RPCs (approval_route /
 *     approval_decide).
 *  2. Direct INSERT/UPDATE/DELETE grants on approval_requests /
 *     approval_history are revoked from `authenticated` / `anon` — all
 *     traffic must flow through the RPCs.
 *  3. Only the sanctioned client helper (`src/lib/governance/approvalEngine.ts`)
 *     is allowed to call these RPCs; other app code must not embed
 *     `.rpc("approval_route"|"approval_decide")` string literals.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function findPhase3Migration(): string {
  const dir = join(process.cwd(), "supabase", "migrations");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql"))) {
    const body = readFileSync(join(dir, f), "utf8");
    if (
      body.includes("CREATE OR REPLACE FUNCTION public.approval_route") &&
      body.includes("CREATE OR REPLACE FUNCTION public.approval_decide")
    ) {
      return body;
    }
  }
  throw new Error("Phase 3 approval engine RPC migration not found");
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

describe("Approval engine — Phase 3 single entry points", () => {
  const sql = findPhase3Migration();

  it("declares approval_route + approval_decide RPCs with EXECUTE grants", () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.approval_route/);
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.approval_decide/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.approval_route[\s\S]*authenticated/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.approval_decide[\s\S]*authenticated/);
  });

  it("revokes direct writes on approval_requests / approval_history", () => {
    expect(sql).toMatch(
      /REVOKE\s+INSERT,\s*UPDATE,\s*DELETE\s+ON\s+public\.approval_requests\s+FROM\s+authenticated,\s*anon/i,
    );
    expect(sql).toMatch(
      /REVOKE\s+INSERT,\s*UPDATE,\s*DELETE\s+ON\s+public\.approval_history\s+FROM\s+authenticated,\s*anon/i,
    );
  });

  it("only the sanctioned client helper embeds the RPC names", () => {
    const allowed = new Set([
      join("src", "lib", "governance", "approvalEngine.ts"),
      join("src", "test", "architecture", "approval-engine-entrypoints.test.ts"),
    ]);
    const offenders: string[] = [];
    for (const file of walk(join(process.cwd(), "src"))) {
      const rel = file.slice(process.cwd().length + 1);
      if ([...allowed].some((a) => rel.endsWith(a))) continue;
      const body = readFileSync(file, "utf8");
      if (/rpc\(\s*["'`]approval_(route|decide)["'`]/.test(body)) {
        offenders.push(rel);
      }
    }
    expect(
      offenders,
      `Direct RPC calls to approval_route/approval_decide must go through src/lib/governance/approvalEngine.ts. Offenders: ${offenders.join(", ")}`,
    ).toEqual([]);
  });
});
