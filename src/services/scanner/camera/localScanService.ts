/**
 * localScanService — the single entry point for "scan with THIS device's
 * camera".
 *
 * A surface calls `openLocalScan({ label, continuous })`; the globally
 * mounted `<LocalScanOverlay>` opens the viewfinder, decodes locally and
 * emits onto `scanBus` with `source: "camera"` and NO `sourceTopic`, so
 * `scanRouter` delivers the code to whichever target is active — exactly
 * as if a USB gun had fired. Nothing downstream (BarcodeInputField,
 * useWmsScanIntent, POS cart) needs to know the camera exists.
 *
 * Guarded by `src/test/architecture/scanner-local-scan-entry.test.ts`:
 * no component may emit `source: "camera"` onto the bus itself.
 */
import { scanBus, type ScanEvent } from "@/services/pos/scanBus";
import { parseScanPayload } from "@/services/pos/parseBarcode";

export interface LocalScanRequest {
  /** Shown in the viewfinder header — e.g. "Scan destination bin". */
  label?: string;
  /** Keep the viewfinder open after each decode (receiving / counting). */
  continuous?: boolean;
  /** Symbology override; defaults to the retail/logistics pack. */
  formats?: string[];
  /** Fired when the overlay closes, with the number of accepted scans. */
  onClose?: (count: number) => void;
}

type Listener = (req: LocalScanRequest | null) => void;

const listeners = new Set<Listener>();
let current: LocalScanRequest | null = null;

function notify() {
  for (const l of Array.from(listeners)) {
    try { l(current); } catch { /* ignore */ }
  }
}

/** Open the device-local viewfinder. Replaces any request already open. */
export function openLocalScan(req: LocalScanRequest = {}): void {
  current = req;
  notify();
}

/** Close the viewfinder. `count` is reported back to the opener. */
export function closeLocalScan(count = 0): void {
  const req = current;
  current = null;
  notify();
  req?.onClose?.(count);
}

export const localScanService = {
  open: openLocalScan,
  close: closeLocalScan,
  isOpen(): boolean {
    return current !== null;
  },
  current(): LocalScanRequest | null {
    return current;
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    listener(current);
    return () => listeners.delete(listener);
  },
  /**
   * Push a locally decoded code onto the kernel. ONLY the overlay calls
   * this — see the architecture guard.
   */
  emitDecoded(raw: string): ScanEvent {
    const parsed = parseScanPayload(raw);
    const event: ScanEvent = {
      raw,
      code: parsed.code,
      quantity: parsed.quantity,
      at: Date.now(),
      source: "camera",
      scanId:
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random()}`,
      decodedAt: Date.now(),
    };
    scanBus.emit(event);
    return event;
  },
  /** Test helper. */
  _reset(): void {
    current = null;
    listeners.clear();
  },
};
