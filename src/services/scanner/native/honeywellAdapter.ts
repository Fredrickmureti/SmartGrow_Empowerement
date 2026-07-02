/**
 * honeywellAdapter — listens for Honeywell DataCollection / SwiftDecoder
 * scan output and republishes it through `nativeScanBus`.
 *
 * Honeywell ruggedized Android devices (CT4x, CT47, CK65, EDA series)
 * expose decoded scans via:
 *   1. **JS bridge** — `window.HoneywellScanner` (EZConfig web-data shim).
 *   2. **DOM event** — the DataCollection "Web Intent" profile dispatches
 *      `CustomEvent('honeywellscan', { detail: { data, codeId, aimId } })`
 *      on `window`.
 *
 * Payload shape, per Honeywell DataCollection Web Intent documentation:
 *   { data: string, codeId?: string, aimId?: string, charset?: string }
 */

import { nativeScanBus } from "./nativeScanBus";

const DEDUPE_MS = 200;

interface HoneywellPayload {
  data?: unknown;
  codeId?: unknown;
  aimId?: unknown;
}

let started = false;
let lastCode = "";
let lastAt = 0;
let handler: ((ev: Event) => void) | null = null;
let bridgeOriginal: unknown = null;

function emit(raw: unknown): void {
  if (!raw || typeof raw !== "object") return;
  const p = raw as HoneywellPayload;
  const code = typeof p.data === "string" ? p.data.trim() : "";
  if (!code) return;
  const now = Date.now();
  if (code === lastCode && now - lastAt < DEDUPE_MS) return;
  lastCode = code;
  lastAt = now;
  nativeScanBus.emit({
    code,
    symbology: typeof p.codeId === "string" ? p.codeId : null,
    aim: typeof p.aimId === "string" ? p.aimId : null,
    source: "honeywell",
    at: now,
  });
}

export const honeywellAdapter = {
  start(): void {
    if (started || typeof window === "undefined") return;
    started = true;

    handler = (ev: Event) => {
      const detail = (ev as CustomEvent).detail;
      if (typeof detail === "string") {
        try { emit(JSON.parse(detail)); } catch { /* ignore */ }
      } else {
        emit(detail);
      }
    };
    window.addEventListener("honeywellscan", handler);

    const w = window as unknown as Record<string, unknown>;
    const existing = w.HoneywellScanner as { onScan?: unknown } | undefined;
    if (existing && typeof existing === "object") {
      bridgeOriginal = existing.onScan;
      (existing as { onScan: (p: unknown) => void }).onScan = (payload: unknown) => {
        if (typeof bridgeOriginal === "function") {
          try { (bridgeOriginal as (p: unknown) => void)(payload); } catch { /* ignore */ }
        }
        if (typeof payload === "string") {
          try { emit(JSON.parse(payload)); } catch { /* ignore */ }
        } else {
          emit(payload);
        }
      };
    }
  },

  stop(): void {
    if (!started || typeof window === "undefined") return;
    if (handler) window.removeEventListener("honeywellscan", handler);
    handler = null;
    const w = window as unknown as Record<string, unknown>;
    const existing = w.HoneywellScanner as { onScan?: unknown } | undefined;
    if (existing && typeof existing === "object") {
      (existing as { onScan: unknown }).onScan = bridgeOriginal ?? undefined;
    }
    bridgeOriginal = null;
    started = false;
    lastCode = "";
    lastAt = 0;
  },

  _ingest(raw: unknown): void { emit(raw); },
  _reset(): void { started = false; lastCode = ""; lastAt = 0; bridgeOriginal = null; handler = null; },
};
