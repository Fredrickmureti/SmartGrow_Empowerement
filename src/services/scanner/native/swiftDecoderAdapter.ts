/**
 * swiftDecoderAdapter — listens for Honeywell SwiftDecoder scans coming
 * from a native iOS WebView wrapper and republishes them through
 * `nativeScanBus`.
 *
 * Contract with the iOS shell (documented in
 * `docs/scanner/honeywell-swiftdecoder-ios-bridge.md`):
 *
 *   1. The iOS app injects a sentinel object before the WebView loads:
 *        window.__swiftDecoderBridge__ = { version: "1" }
 *      Its presence is what `detectNativeScanner` keys on.
 *
 *   2. For every decoded barcode the iOS side fires:
 *        window.dispatchEvent(new CustomEvent("swiftdecoder", {
 *          detail: { data: "<code>", codeId?: "<symbology>", aimId?: "<aim>" }
 *        }))
 *
 *   3. Optionally the bridge can expose `.onScan(payload)` and this
 *      adapter will wrap it so any host-side handler keeps firing.
 *
 * Adapter is a strict no-op on any other platform — no listeners
 * attached, no globals touched.
 */

import { nativeScanBus } from "./nativeScanBus";

const DEDUPE_MS = 200;

interface SwiftDecoderPayload {
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
  const p = raw as SwiftDecoderPayload;
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
    source: "honeywell-ios",
    at: now,
  });
}

export const swiftDecoderAdapter = {
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
    window.addEventListener("swiftdecoder", handler);

    const w = window as unknown as Record<string, unknown>;
    const bridge = w.__swiftDecoderBridge__ as { onScan?: unknown } | undefined;
    if (bridge && typeof bridge === "object") {
      bridgeOriginal = bridge.onScan;
      (bridge as { onScan: (p: unknown) => void }).onScan = (payload: unknown) => {
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
    if (handler) window.removeEventListener("swiftdecoder", handler);
    handler = null;
    const w = window as unknown as Record<string, unknown>;
    const bridge = w.__swiftDecoderBridge__ as { onScan?: unknown } | undefined;
    if (bridge && typeof bridge === "object") {
      (bridge as { onScan: unknown }).onScan = bridgeOriginal ?? undefined;
    }
    bridgeOriginal = null;
    started = false;
    lastCode = "";
    lastAt = 0;
  },

  _ingest(raw: unknown): void { emit(raw); },
  _reset(): void { started = false; lastCode = ""; lastAt = 0; bridgeOriginal = null; handler = null; },
};
