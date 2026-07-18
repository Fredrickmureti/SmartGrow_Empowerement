/**
 * Wave 2 · Phase F — Card settlement architecture guard.
 *
 * Locks the invariants:
 *   - Migration creates pos_card_settlements + pos_card_settlement_lines.
 *   - Apply RPC + close RPC exist and the close RPC emits settlement.card.closed.
 *   - The dispatcher wires payment.card.captured / .reversed handlers.
 *   - No src/ file writes to the two settlement tables directly (all writes
 *     go through the RPCs).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const REPO = process.cwd();
const MIG_DIR = join(REPO, "supabase/migrations");
const migrations = readdirSync(MIG_DIR)
  .filter((f) => f.endsWith(".sql"))
  .map((f) => readFileSync(join(MIG_DIR, f), "utf8"))
  .join("\n");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if (/\.(t|j)sx?$/.test(name)) out.push(p);
  }
  return out;
}
const srcFiles = walk(join(REPO, "src"));

describe("pos-card-settlement: substrate & write-path invariants", () => {
  it("migration creates settlement tables", () => {
    expect(migrations).toMatch(/CREATE TABLE IF NOT EXISTS public\.pos_card_settlements/);
    expect(migrations).toMatch(/CREATE TABLE IF NOT EXISTS public\.pos_card_settlement_lines/);
  });

  it("migration defines apply + close RPCs and registers the topic", () => {
    expect(migrations).toMatch(/FUNCTION\s+public\.pos_card_settlement_apply/);
    expect(migrations).toMatch(/FUNCTION\s+public\.pos_close_card_settlement/);
    expect(migrations).toContain("settlement.card.closed");
  });

  it("close RPC emits settlement.card.closed to business_event_outbox", () => {
    // A crude but effective guard: the string 'settlement.card.closed' appears
    // inside an INSERT INTO business_event_outbox statement.
    const m = migrations.match(
      /INSERT INTO public\.business_event_outbox[\s\S]{0,800}?settlement\.card\.closed/,
    );
    expect(m, "close RPC must insert into business_event_outbox").not.toBeNull();
  });

  it("outbox dispatcher wires capture + reversal handlers", () => {
    const src = readFileSync(join(REPO, "supabase/functions/outbox-dispatcher/index.ts"), "utf8");
    expect(src).toMatch(/"payment\.card\.captured"\s*:/);
    expect(src).toMatch(/"payment\.card\.reversed"\s*:/);
    expect(src).toMatch(/pos_card_settlement_apply/);
  });

  it("no src/ file writes to the settlement tables directly", () => {
    const banned = ["pos_card_settlements", "pos_card_settlement_lines"];
    const offenders = srcFiles.filter((p) => {
      if (p.includes("/test/") || p.includes("__tests__")) return false;
      const s = readFileSync(p, "utf8");
      return banned.some((t) =>
        new RegExp(`\\.from\\(["']${t}["']\\)[\\s\\S]{0,200}\\.(insert|update|upsert|delete)\\(`).test(s),
      );
    });
    expect(offenders, `writes must go through pos_card_settlement_apply / pos_close_card_settlement: ${offenders.join(", ")}`)
      .toEqual([]);
  });
});
