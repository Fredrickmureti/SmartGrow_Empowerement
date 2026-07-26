/**
 * HostRouter — Wave 9d Phase 5 Step B (foundation).
 *
 * Single source of truth for **runtime host** questions. `TransportRouter`
 * answers "given this assignment, which transport should we open?".
 * `HostRouter` answers "does this runtime host expose an Electron
 * main-process IPC bridge, a preload capability probe, an OS bluetooth
 * radio?".
 *
 * Every other module in the hardware layer MUST consult `hostRouter`
 * instead of poking `window.pos.*` directly. The
 * `no-raw-electron-api` guard test enforces this — only this file,
 * `TransportRouter.ts`, `environment.ts`, and the local-display shell
 * may reference `window.pos.isElectron` / `window.pos.hardware.exec`.
 *
 * Rationale
 * ---------
 * Before this file existed, `HardwareClient.ts` inlined `ipcAvailable()`
 * and `isElectronMode()` and every namespace re-called them ~15 times.
 * That duplication is what the audit flagged as "scattered isElectron
 * branches". Collapsing to this single accessor lets Step C delete the
 * legacy `resolveTransport()` and `LocalAgentTransport` renderer shim
 * without a whack-a-mole grep across the client.
 */

import { isElectron as isElectronEnv } from "@/lib/environment";

/** Narrowed shape of the Electron preload's `window.pos` bridge. */
interface PosBridge {
  isElectron?: boolean;
  hardware?: { exec?: unknown; capabilities?: () => Promise<unknown> };
  devices?: unknown;
  bluetooth?: unknown;
  app?: unknown;
  sale?: unknown;
  platform?: string;
}

function posBridge(): PosBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { pos?: PosBridge }).pos;
}

/**
 * True when the main-process CommandRouter IPC (`window.pos.hardware.exec`)
 * is reachable from the renderer. This is the ONLY predicate that gates
 * the Electron-native execution path.
 */
export function ipcAvailable(): boolean {
  return Boolean(posBridge()?.hardware?.exec);
}

/**
 * True when the renderer is running inside an Electron shell (preload
 * signalled `pos.isElectron` OR user-agent sniffing agrees). This is a
 * *host* check, not a capability check — use `ipcAvailable()` before
 * calling into the IPC bridge.
 */
export function isElectronHost(): boolean {
  return Boolean(posBridge()?.isElectron) || isElectronEnv();
}

/**
 * `ipcAvailable && !isElectronHost` should never happen. When it does
 * (a stale preload bundle inside an Electron shell), the client will
 * fall back to the browser adapter. Callers wanting to detect that
 * mismatch use this helper to emit a single-shot warning.
 */
export function hasStalePreload(): boolean {
  return isElectronHost() && !ipcAvailable();
}

/**
 * Convenience snapshot for diagnostics / test injection.
 */
export interface HostSnapshot {
  isElectronHost: boolean;
  ipcAvailable: boolean;
  hasStalePreload: boolean;
}

export function snapshotHost(): HostSnapshot {
  return {
    isElectronHost: isElectronHost(),
    ipcAvailable: ipcAvailable(),
    hasStalePreload: hasStalePreload(),
  };
}

/** Grouped export mirrors the `hardwareClient.*` namespacing style. */
export const hostRouter = {
  ipcAvailable,
  isElectronHost,
  hasStalePreload,
  snapshot: snapshotHost,
};
