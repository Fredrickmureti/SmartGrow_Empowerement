/**
 * dataWedgeAdapter — listens for Zebra DataWedge scan output and
 * republishes it through `nativeScanBus`.
 *
 * DataWedge can deliver decoded scans to a web page in two ways:
 *   1. **JS injection** — DataWedge profile "JavaScript injection" calls
 *      `window.DWBridgeWebView.scan(json)` (or `window.datawedge(json)`).
 *   2. **Intent → CustomEvent shim** — a tiny WebView shim deployed with
 *      the StageNow profile dispatches `new CustomEvent('datawedge', { detail })`
 *      on `window` with `{ data, labelType }`.
 *
 * This adapter subscribes to both transports. The expected payload shape
 * matches the documented DataWedge "Plugin output" JSON:
 *   { data: string, labelType?: string, source?: string }
 * Anything else is dropped silently.
 *
 * Adapter is idempotent — `start()` twice is a no-op; `stop()` is safe.
 * Built-in 200 ms dedupe guards against the JS-bridge and intent-shim
 * both firing for the same trigger pull on misconfigured profiles.
 */

import { nativeScanBus } from "./nativeScanBus";

const DEDUPE_MS = 200;

interface DataWedgePayload {
  data?: unknown;
  labelType?: unknown;
}

let started = false;
let lastCode = "";
let lastAt = 0;
let handler: ((ev: Event) => void) | null = null;
let bridgeOriginal: unknown = null;

function emit(raw: unknown): void {
  if (!raw || typeof raw !== "object") return;
  const p = raw as DataWedgePayload;
  const code = typeof p.data === "string" ? p.data.trim() : "";
  if (!code) return;
  const now = Date.now();
  if (code === lastCode && now - lastAt < DEDUPE_MS) return;
  lastCode = code;
  lastAt = now;
  nativeScanBus.emit({
    code,
    symbology: typeof p.labelType === "string" ? p.labelType : null,
    aim: null,
    source: "zebra",
    at: now,
  });
}

export const dataWedgeAdapter = {
  start(): void {
    if (started || typeof window === "undefined") return;
    started = true;

    // Transport 1 — intent → CustomEvent('datawedge', { detail })
    handler = (ev: Event) => {
      const detail = (ev as CustomEvent).detail;
      if (typeof detail === "string") {
        try { emit(JSON.parse(detail)); } catch { /* ignore */ }
      } else {
        emit(detail);
      }
    };
    window.addEventListener("datawedge", handler);

    // Transport 2 — JS injection bridge. Wrap whatever DataWedge installed
    // so we forward to the bus AND preserve any existing handler.
    const w = window as unknown as Record<string, unknown>;
    bridgeOriginal = w.datawedge ?? null;
    w.datawedge = (payload: unknown) => {
      if (typeof bridgeOriginal === "function") {
        try { (bridgeOriginal as (p: unknown) => void)(payload); } catch { /* ignore */ }
      }
      if (typeof payload === "string") {
        try { emit(JSON.parse(payload)); } catch { /* ignore */ }
      } else {
        emit(payload);
      }
    };
  },

  stop(): void {
    if (!started || typeof window === "undefined") return;
    if (handler) window.removeEventListener("datawedge", handler);
    handler = null;
    const w = window as unknown as Record<string, unknown>;
    w.datawedge = bridgeOriginal ?? undefined;
    bridgeOriginal = null;
    started = false;
    lastCode = "";
    lastAt = 0;
  },

  /** Test-only — direct entry point bypassing window listeners. */
  _ingest(raw: unknown): void { emit(raw); },
  _reset(): void { started = false; lastCode = ""; lastAt = 0; bridgeOriginal = null; handler = null; },
};
