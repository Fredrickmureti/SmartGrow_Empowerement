/**
 * Architecture guard — WMS Phase 6 (Dock scheduling & appointments).
 *
 * Appointment writes must flow exclusively through the sanctioned RPCs:
 *   schedule_dock_appointment
 *   mark_appointment_arrived
 *   start_appointment
 *   complete_dock_appointment
 *   cancel_dock_appointment
 *
 * `wms_loading_manifests.appointment_id` and
 * `goods_receipts.appointment_id` are stamped by
 * `open_loading_manifest` / `bind_goods_receipt_appointment`.
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

describe("wms phase 6 architecture", () => {
  const files = walk(SRC).filter((f) => f !== SELF && !/\btest\b/.test(f));

  it("no client code mutates wms_dock_appointments directly", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      if (/from\(\s*["']wms_dock_appointments["']\s*\)\s*\.(insert|update|upsert|delete)\s*\(/.test(src)) {
        offenders.push(path.relative(SRC, f));
      }
    }
    expect(offenders, `Appointments must go through schedule_/mark_/start_/complete_/cancel_ RPCs:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("schedule pages call the sanctioned RPCs", () => {
    const planner = readFileSync(path.join(SRC, "pages/warehouse/AppointmentPlanner.tsx"), "utf8");
    const schedule = readFileSync(path.join(SRC, "pages/warehouse/DockSchedule.tsx"), "utf8");
    expect(/schedule_dock_appointment/.test(planner)).toBe(true);
    expect(/mark_appointment_arrived/.test(schedule)).toBe(true);
    expect(/start_appointment/.test(schedule)).toBe(true);
    expect(/complete_dock_appointment/.test(schedule)).toBe(true);
    expect(/cancel_dock_appointment/.test(schedule)).toBe(true);
  });
});