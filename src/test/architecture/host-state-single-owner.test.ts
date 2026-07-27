/**
 * Architecture guard — host-state single owner (Phase 5 Step B, step 6).
 *
 * "Which runtime host am I on?" is a hardware-platform question, not an
 * application question. Before this guard, `HardwareClient` re-derived it
 * inline a dozen times with raw `window.pos` casts, which is exactly how
 * the audit's "scattered isElectron branches" drift started.
 *
 * Rule: inside `src/services/hardware/**` and `src/hooks/hardware/**`,
 * only `transport/HostRouter.ts` (and the pure `TransportRouter`, which
 * receives an injected host snapshot) may read the raw bridge or sniff
 * the host. Everyone else consults `hostRouter` / `hostBridge`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, relative } from "node:path";

const SRC = resolve(__dirname, "../..");
const ROOTS = ["services/hardware", "hooks/hardware"];

const ALLOWED = new Set([
  "services/hardware/transport/HostRouter.ts",
  "services/hardware/transport/TransportRouter.ts",
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const FILES = ROOTS.flatMap((r) => walk(join(SRC, r))).map((f) => ({
  rel: relative(SRC, f).split("\\").join("/"),
  src: readFileSync(f, "utf8"),
}));

describe("host state has a single owner", () => {
  it("no hardware-layer file casts window.pos directly", () => {
    const offenders = FILES.filter(
      (f) => !ALLOWED.has(f.rel) && /\(window as unknown as[\s\S]{0,120}pos/.test(f.src),
    ).map((f) => f.rel);
    expect(offenders, "use hostBridge() from transport/HostRouter").toEqual([]);
  });

  it("HostRouter exposes the sanctioned accessors", () => {
    const src = FILES.find((f) => f.rel === "services/hardware/transport/HostRouter.ts")!.src;
    for (const sym of ["ipcAvailable", "isElectronHost", "hostBridge", "snapshotHost"]) {
      expect(src).toMatch(new RegExp(`export function ${sym}`));
    }
  });

  it("HardwareClient derives host state only through HostRouter", () => {
    const src = FILES.find((f) => f.rel === "services/hardware/HardwareClient.ts")!.src;
    expect(src).toMatch(/from "\.\/transport\/HostRouter"/);
    expect(src).not.toMatch(/navigator\.(usb|hid)/);
  });
});
