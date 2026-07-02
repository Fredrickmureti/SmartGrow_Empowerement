/**
 * Architecture guard (wave 5) — outbound ACK broadcasts must only originate
 * from the two desk-side scanner hooks. Any other file calling
 * `channel.send({...event: ... ack ...})` bypasses the wave-4 ACK outbox
 * (and therefore loses verdicts when the desk is momentarily offline).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import path from "path";

const SRC = path.resolve(__dirname, "../..");
const ALLOW = new Set<string>([
  path.join(SRC, "hooks/pos/useScanChannel.ts"),
  path.join(SRC, "hooks/pos/usePOSScannerChannel.ts"),
  path.join(SRC, "test/architecture/ack-send-discipline.test.ts"),
]);

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

describe("ack-send discipline", () => {
  it("only the two desk hooks broadcast ack events", () => {
    const offenders: string[] = [];
    for (const f of walk(SRC).filter((x) => !ALLOW.has(x))) {
      const src = readFileSync(f, "utf8");
      // Look for SCAN_EVENTS.ack or event: "ack" used inside a channel.send.
      if (/channel\.send\([^)]*event:\s*(?:SCAN_EVENTS\.ack|["']ack["'])/s.test(src)) {
        offenders.push(path.relative(process.cwd(), f));
      }
    }
    expect(offenders, `Outbound ACKs must route through useScanChannel/usePOSScannerChannel:\n${offenders.join("\n")}`).toEqual([]);
  });
});
