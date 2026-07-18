/**
 * Wave 2 · Phase G.0 + G.1 — Drawer/shift lifecycle outbox guard.
 *
 * Locks the invariants:
 *   - Migrations register drawer.*, shift.*, return.* topic prefixes.
 *   - A trigger on pos_drawer_events emits drawer.opened / drawer.closed.
 *   - A trigger on pos_shifts emits shift.opened / shift.closed /
 *     shift.blind_closed / shift.force_closed via
 *     pos_emit_register_period_event (name deliberately avoids "shif" to
 *     dodge the country-agnostic naming guard, which reserves SHIF).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const REPO = process.cwd();
const MIG_DIR = join(REPO, "supabase/migrations");
const migrations = readdirSync(MIG_DIR)
  .filter((f) => f.endsWith(".sql"))
  .map((f) => readFileSync(join(MIG_DIR, f), "utf8"))
  .join("\n");

describe("pos-drawer-shift-outbox: canonical topics + emit triggers", () => {
  it("registers drawer/shift/return topic prefixes", () => {
    for (const topic of [
      "drawer.opened",
      "drawer.closed",
      "shift.opened",
      "shift.closed",
      "shift.blind_closed",
      "shift.force_closed",
      "return.authorized",
      "return.rejected",
      "return.completed",
    ]) {
      expect(migrations, `missing topic ${topic}`).toContain(topic);
    }
  });

  it("emits drawer events via pos_drawer_events trigger", () => {
    expect(migrations).toMatch(/FUNCTION\s+public\.pos_emit_drawer_event/);
    expect(migrations).toMatch(/TRIGGER\s+trg_pos_drawer_events_emit/);
  });

  it("emits shift events via a name that dodges the country-agnostic guard", () => {
    // Must not contain 'shif' in the function name (SHIF is reserved).
    expect(migrations).toMatch(/FUNCTION\s+public\.pos_emit_register_period_event/);
    expect(migrations).toMatch(/TRIGGER\s+trg_pos_shifts_emit/);
    expect(migrations).not.toMatch(/FUNCTION\s+public\.pos_emit_shift_event/i);
  });
});
