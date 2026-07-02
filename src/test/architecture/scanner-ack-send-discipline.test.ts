/**
 * Architecture guard — only the two desk-side hooks may broadcast
 * `ack` / `revoke` / `ping` control events on the scanner Realtime
 * channels (`pos:scan:*` and `scan:session:*`). The phone's
 * `MobileScannerPage` legitimately replies with `pong`, so `pong` is
 * intentionally NOT covered by this guard.
 *
 * Wire schema is defined in `src/services/scanner/ackPayload.ts` and
 * pinned by `ack-payload-contract.test.ts`. Any code that bypasses the
 * two sanctioned senders would silently break the cockpit contract
 * (ACK band, RTT telemetry, typed revoke reasons, mirrored feedback).
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import path from "path";

const SRC = path.resolve(__dirname, "../..");

const ALLOW = new Set<string>([
  path.join(SRC, "hooks/pos/useScanChannel.ts"),
  path.join(SRC, "hooks/pos/usePOSScannerChannel.ts"),
  // The guard itself contains the literal event names.
  path.join(SRC, "test/architecture/scanner-ack-send-discipline.test.ts"),
]);

const CONTROL_EVENTS = ["ack", "revoke", "ping"] as const;

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

/**
 * Returns offending event names found in `src` where a `channel.send(`
 * (or `ch.send(`) call is preceded — within the same call object — by
 * an `event: "<control>"` literal.
 *
 * We scan with a permissive regex that captures the `.send({ ... })`
 * object body, then look for `event: "<name>"` inside it. This catches
 * the normal Supabase Realtime broadcast shape without trying to be a
 * full parser.
 */
function findControlSends(src: string): string[] {
  const offenders: string[] = [];
  // Match `.send(` followed by `{ ... }` payload up to the matching `)`
  // — non-greedy, single object literal per call.
  const callRe = /\.send\s*\(\s*\{([\s\S]*?)\}\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(src)) !== null) {
    const body = m[1];
    const eventMatch = body.match(/event\s*:\s*["']([a-z_]+)["']/i);
    if (!eventMatch) continue;
    const evt = eventMatch[1];
    if ((CONTROL_EVENTS as readonly string[]).includes(evt)) {
      offenders.push(evt);
    }
  }
  return offenders;
}

describe("scanner control-event broadcast discipline", () => {
  it("only useScanChannel/usePOSScannerChannel may broadcast ack/revoke/ping", () => {
    const offenders: string[] = [];
    const files = walk(SRC).filter((f) => !ALLOW.has(f));
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      const hits = findControlSends(src);
      if (hits.length > 0) {
        offenders.push(`${path.relative(process.cwd(), f)} → ${hits.join(", ")}`);
      }
    }
    expect(
      offenders,
      `These files bypass the desk-side scanner hooks by broadcasting control events directly:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
