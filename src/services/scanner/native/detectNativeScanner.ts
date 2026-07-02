/**
 * detectNativeScanner — pure capability probe for ruggedized Android
 * handhelds that expose a native scan engine (Zebra DataWedge,
 * Honeywell DataCollection / SwiftDecoder).
 *
 * Returns `vendor: null` on consumer phones, desktops, and iOS — the
 * caller (MobileScannerPage) then falls back to camera + keyboard wedge
 * exactly as before. This file MUST stay pure (no DOM listeners, no
 * side effects) so the unit suite can drive it with synthetic UAs.
 */

export type NativeScannerVendor = "zebra" | "honeywell" | "honeywell-ios";

export type NativeScannerTransport =
  | "intent"      // Android intent broadcast captured by adapter event
  | "js-bridge"   // window.DWBridgeWebView / Honeywell JS shim
  | "keystroke";  // last-resort fallback (already covered by useScanCapture)

export interface NativeScannerCapability {
  vendor: NativeScannerVendor | null;
  transport: NativeScannerTransport;
  /** 0–1; <0.5 means treat as fallback only. */
  confidence: number;
  /** Human label for the cockpit chip ("Zebra DataWedge", "Honeywell scan engine"). */
  label: string | null;
}

// Zebra model fragments that show up in the Android UA on TC2x/TC5x/MC9x
// handhelds. Matched case-insensitively against the build model token.
const ZEBRA_MODEL_RX = /\b(TC[0-9]{2}[a-z]{0,3}|MC[0-9]{2,4}[a-z]{0,3}|ET[0-9]{2}[a-z]{0,3}|EC[0-9]{2}[a-z]{0,3}|CC[0-9]{2}|WT[0-9]{2})\b/i;
const ZEBRA_BRAND_RX = /\bZebra\b/i;

// Honeywell ruggedized handhelds (CT family, CK family, Dolphin).
const HONEYWELL_MODEL_RX = /\b(CT[0-9]{2}[a-z]{0,3}|CK[0-9]{2}[a-z]{0,3}|EDA[0-9]{2,3}[a-z]{0,3}|Dolphin)\b/i;
const HONEYWELL_BRAND_RX = /\bHoneywell\b/i;

interface Probe {
  userAgent?: string;
  hasDWBridge?: boolean;
  hasHoneywellBridge?: boolean;
  /** Set by the iOS WebView wrapper before page load. */
  hasSwiftDecoderBridge?: boolean;
}

export function detectNativeScannerFrom(probe: Probe): NativeScannerCapability {
  const ua = probe.userAgent ?? "";
  const isAndroid = /Android/i.test(ua);
  const isIOS = /iPhone|iPad|iPod/i.test(ua);

  // iOS with the SwiftDecoder bridge present → Honeywell-iOS engine.
  // The bridge sentinel is the authoritative signal; a normal mobile
  // Safari tab without the iOS shell stays vendor:null and falls back
  // to camera/keyboard wedge.
  if (isIOS && probe.hasSwiftDecoderBridge) {
    return {
      vendor: "honeywell-ios",
      transport: "js-bridge",
      confidence: 1,
      label: "SwiftDecoder",
    };
  }

  // iOS without bridge, desktop, generic Android → no native engine
  if (!isAndroid) {
    return { vendor: null, transport: "keystroke", confidence: 0, label: null };
  }

  const zebra = ZEBRA_BRAND_RX.test(ua) || ZEBRA_MODEL_RX.test(ua);
  const honeywell = HONEYWELL_BRAND_RX.test(ua) || HONEYWELL_MODEL_RX.test(ua);

  if (zebra) {
    return {
      vendor: "zebra",
      transport: probe.hasDWBridge ? "js-bridge" : "intent",
      confidence: probe.hasDWBridge ? 1 : 0.8,
      label: "Zebra DataWedge",
    };
  }
  if (honeywell) {
    return {
      vendor: "honeywell",
      transport: probe.hasHoneywellBridge ? "js-bridge" : "intent",
      confidence: probe.hasHoneywellBridge ? 1 : 0.8,
      label: "Honeywell scan engine",
    };
  }
  return { vendor: null, transport: "keystroke", confidence: 0, label: null };
}

export function detectNativeScanner(): NativeScannerCapability {
  if (typeof navigator === "undefined" || typeof window === "undefined") {
    return { vendor: null, transport: "keystroke", confidence: 0, label: null };
  }
  return detectNativeScannerFrom({
    userAgent: navigator.userAgent,
    // DataWedge JS-injection profile exposes this when enabled.
    hasDWBridge: typeof (window as unknown as { DWBridgeWebView?: unknown }).DWBridgeWebView !== "undefined",
    // Honeywell EZConfig "DataCollection" web shim.
    hasHoneywellBridge: typeof (window as unknown as { HoneywellScanner?: unknown }).HoneywellScanner !== "undefined",
    // SwiftDecoder iOS WebView wrapper sentinel.
    hasSwiftDecoderBridge: typeof (window as unknown as { __swiftDecoderBridge__?: unknown }).__swiftDecoderBridge__ !== "undefined",
  });
}
