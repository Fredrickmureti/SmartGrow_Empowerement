/**
 * Phase 2 architecture guard — Approval engine schema hardening.
 *
 * Pins the Phase 2 migration in place so the canonical engine schema
 * (workflow versioning, request snapshots, idempotency, hash-chained
 * history, hard FK from approval_rules.action_name → registry) cannot
 * silently regress.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

function findPhase2Migration(): string {
  const dir = join(process.cwd(), "supabase", "migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql"));
  for (const f of files) {
    const body = readFileSync(join(dir, f), "utf8");
    if (
      body.includes("approval_rules_action_name_fk") &&
      body.includes("_approval_history_chain")
    ) {
      return body;
    }
  }
  throw new Error("Phase 2 approval-engine migration not found");
}

describe("Approval engine — Phase 2 schema invariants", () => {
  const sql = findPhase2Migration();

  it("workflows carry version + publish state", () => {
    for (const col of ["version", "is_published", "published_at", "superseded_by"]) {
      expect(sql).toContain(col);
    }
  });

  it("requests carry action_key FK, snapshots, and idempotency", () => {
    expect(sql).toMatch(/action_key\s+text[\s\S]*REFERENCES\s+public\.governance_action_registry/);
    expect(sql).toContain("payload_snapshot");
    expect(sql).toContain("context_snapshot");
    expect(sql).toContain("idempotency_key");
    expect(sql).toContain("uq_approval_requests_org_idem");
  });

  it("history is hash-chained and append-only", () => {
    expect(sql).toContain("_approval_history_chain");
    expect(sql).toMatch(/event_hash\s+text/);
    expect(sql).toMatch(/prev_hash\s+text/);
    expect(sql).toContain("GOV_APPEND_ONLY");
  });

  it("approval_rules.action_name has a hard FK into the registry", () => {
    expect(sql).toMatch(
      /ADD CONSTRAINT approval_rules_action_name_fk[\s\S]*REFERENCES\s+public\.governance_action_registry\(action_key\)/
    );
    expect(sql).toContain("DROP TRIGGER IF EXISTS trg_approval_rules_registry_check");
  });

  it("exposes approval_history_verify integrity RPC", () => {
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.approval_history_verify");
    expect(sql).toContain("GRANT EXECUTE ON FUNCTION public.approval_history_verify");
  });
});
