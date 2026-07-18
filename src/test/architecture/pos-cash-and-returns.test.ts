/**
 * Wave 2 · Phase G.2–G.4 — Cash lifecycle & return-authorization guards.
 *
 * Locks the invariants:
 *   - Blind vs open register-period close is expressed as a canonical
 *     `close_mode` column plus the two closer RPCs; the reconcile RPC is
 *     the only path to stamp counted cash on a blindly-closed shift.
 *   - Return authorization FSM (requested → approved/rejected → applied)
 *     ships with an idempotency ledger and outbox emit trigger.
 *   - Neither client (`src/`) nor edge code inserts directly into
 *     `journal_entries` for return authorizations — that JE only comes
 *     from the dispatcher path keyed on the apply-log PK.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const REPO = process.cwd();
const MIG_DIR = join(REPO, "supabase/migrations");
const migrations = readdirSync(MIG_DIR)
  .filter((f) => f.endsWith(".sql"))
  .map((f) => readFileSync(join(MIG_DIR, f), "utf8"))
  .join("\n");

function readSrcFiles(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...readSrcFiles(p));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(p);
  }
  return out;
}

describe("pos-cash-and-returns: G.2 blind-close policy", () => {
  it("adds a close_mode column to pos_shifts", () => {
    expect(migrations).toMatch(/pos_shifts[\s\S]{0,200}close_mode/);
  });

  it("ships pos_close_register_period + pos_reconcile_register_period RPCs", () => {
    expect(migrations).toMatch(/FUNCTION\s+public\.pos_close_register_period/);
    expect(migrations).toMatch(/FUNCTION\s+public\.pos_reconcile_register_period/);
    // Function names dodge the country-agnostic "shif" ban.
    expect(migrations).not.toMatch(/FUNCTION\s+public\.pos_close_shift\s*\(/i);
  });

  it("reconcile RPC is gated to admin/manager and posts the variance JE", () => {
    const idx = migrations.indexOf("pos_reconcile_register_period");
    expect(idx).toBeGreaterThan(-1);
    const body = migrations.slice(idx, idx + 4000);
    expect(body).toMatch(/has_role\(\s*[^,]+,\s*'(admin|manager)'/);
    expect(body).toMatch(/post_pos_close_variance_gl/);
  });
});

describe("pos-cash-and-returns: G.3 return authorization FSM", () => {
  it("creates pos_return_authorizations with a state check", () => {
    expect(migrations).toMatch(/CREATE TABLE IF NOT EXISTS public\.pos_return_authorizations/);
    expect(migrations).toMatch(
      /state[\s\S]{0,120}CHECK[\s\S]{0,120}'requested'[\s\S]{0,120}'approved'[\s\S]{0,120}'rejected'[\s\S]{0,120}'applied'/,
    );
  });

  it("ships an apply-log ledger keyed on authorization_id", () => {
    expect(migrations).toMatch(
      /CREATE TABLE IF NOT EXISTS public\.pos_return_apply_log[\s\S]{0,300}authorization_id\s+uuid\s+PRIMARY KEY/,
    );
  });

  it("emit trigger routes state transitions to canonical outbox topics", () => {
    expect(migrations).toMatch(/FUNCTION\s+public\.pos_emit_return_authorization_event/);
    expect(migrations).toMatch(/TRIGGER\s+trg_pos_return_authorizations_emit/);
    for (const topic of ["return.authorized", "return.rejected", "return.completed"]) {
      expect(migrations, `missing topic ${topic}`).toContain(topic);
    }
  });

  it("transition RPC enforces manager PIN to reach approved", () => {
    expect(migrations).toMatch(/FUNCTION\s+public\.pos_return_authorization_transition/);
    const idx = migrations.indexOf("pos_return_authorization_transition");
    const body = migrations.slice(idx, idx + 4000);
    expect(body).toMatch(/manager PIN required/i);
    expect(body).toMatch(/pos_manager_pins/);
  });
});

describe("pos-cash-and-returns: G.4 no client-side JE for return authorizations", () => {
  const srcFiles = readSrcFiles(join(REPO, "src"));

  it("no src file inserts journal_entries for a return authorization", () => {
    const offenders: string[] = [];
    for (const file of srcFiles) {
      const text = readFileSync(file, "utf8");
      // Any client-side write to journal_entries that also names the return-authorization module.
      if (
        /from\(\s*['"]journal_entries['"]\s*\)/.test(text) &&
        /pos_return_authorization/.test(text)
      ) {
        offenders.push(file);
      }
    }
    expect(offenders, `client-side JE insert for returns: ${offenders.join(", ")}`).toEqual([]);
  });

  it("no src file writes pos_return_authorizations.state directly (must use RPC)", () => {
    const offenders: string[] = [];
    for (const file of srcFiles) {
      const text = readFileSync(file, "utf8");
      if (
        /from\(\s*['"]pos_return_authorizations['"]\s*\)[\s\S]{0,400}\.update\(/.test(text)
      ) {
        offenders.push(file);
      }
    }
    expect(offenders, `direct UPDATE on pos_return_authorizations: ${offenders.join(", ")}`).toEqual([]);
  });
});
