/**
 * scanBus — tiny in-process pub/sub for barcode scanner events.
 *
 * The scanner kernel (useScanCapture) emits a single, parsed ScanEvent here.
 * Any number of consumers (terminal cart, ReturnDialog, kitchen display,
 * future inventory receiving) can subscribe without each one re-installing
 * its own global key listener. That's the architectural seam that lets us
 * later plug in camera (BarcodeDetector) and serial scale sources without
 * touching consumers.
 */

export interface ScanEvent {
  /** Raw payload as received from the scanner (post-parse trim). */
  raw: string;
  /** Effective code to resolve (after stripping qty/weight wrapper). */
  code: string;
  /** Quantity multiplier from Odoo-style `n*code`. Default 1. */
  quantity: number;
  /** Wall-clock when the burst completed. */
  at: number;
  /**
   * Input source that produced this scan.
   *
   * `hardware` covers dedicated scan engines that decode OUTSIDE the DOM
   * keyboard path (WebHID guns, Electron-bridged devices). They are a
   * source, never a second pipeline: dedupe, router precedence and
   * telemetry apply identically.
   */
  source: "keyboard" | "camera" | "serial" | "manual" | "hardware";
  /**
   * Realtime topic that produced this scan, when the source is a paired
   * phone. Stamped by the channel hooks (`usePOSScannerChannel`,
   * `useScanChannel`) — `pos:scan:<registerId>` or
   * `scan:session:<uuid>`. Absent for keyboard / manual / native sources.
   *
   * Consulted by `scanRouter` when the tenant's Scanner Scope policy is
   * `scoped`: targets only receive scans whose topic they accept.
   * Keyboard / manual scans (no topic) bypass the filter and reach the
   * focused field as in Ambient mode.
   */
  sourceTopic?: string;
  /**
   * Optional stable scan identifier set by the producer (phone-as-scanner
   * stamps a UUID per emitted scan). When present, `scanBus.emit` rejects
   * any subsequent event with the same `scanId` regardless of the timing
   * dedupe window — defends against Supabase realtime re-delivery
   * doubling scans.
   */
  scanId?: string;
  /**
   * Wall-clock when the producer DECODED the scan (Plan P2). For phone
   * broadcasts this is the phone's `decoded_at`; for keyboard wedge it
   * equals `at`. Used desk-side to distinguish live scans from a stale
   * replay drained out of the phone's offline queue.
   */
  decodedAt?: number;
}

export interface ScanProgress {
  /** Current buffer captured so far (printable chars only). */
  buffer: string;
  /** Wall-clock when this keystroke landed. */
  at: number;
  source: "keyboard" | "camera" | "serial" | "manual" | "hardware";
  /** True once the kernel has decided this burst is definitely a scan. */
  committed: boolean;
}

type Listener = (event: ScanEvent) => void;
type ProgressListener = (p: ScanProgress | null) => void;

const listeners = new Set<Listener>();
const progressListeners = new Set<ProgressListener>();

/**
 * Cross-source dedupe window. Two emits with the same `code` within
 * `DEDUPE_MS` of each other (even from different sources — keyboard +
 * camera + manual) collapse into one. Prevents the classic double-add
 * when a cashier scans with both a wedge gun and a paired phone.
 *
 * Routed targets may opt out of this dedupe (Physical Count, Goods
 * Receipt) by installing a bypass predicate via `setDedupeBypass`.
 * The predicate is consulted on every emit; returning true skips the
 * dedupe check entirely for that event.
 */
const DEDUPE_MS = 250;
let lastEmit: { code: string; at: number } | null = null;
let dedupeBypass: ((event: ScanEvent) => boolean) | null = null;
let routerListener: ((event: ScanEvent) => void) | null = null;
// scanId LRU — bounded so a long-running terminal can't leak. 512 entries
// covers any realistic realtime re-delivery burst.
const seenScanIds: Map<string, number> = new Map();
const MAX_SCAN_IDS = 512;

export const scanBus = {
  on(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  emit(event: ScanEvent): void {
    const now = event.at || Date.now();
    // scanId dedupe — bypass-proof and timing-independent. Producers
    // (phone-as-scanner) stamp a UUID per scan so realtime
    // re-deliveries of the same payload collapse to one cart add.
    if (event.scanId) {
      if (seenScanIds.has(event.scanId)) return;
      seenScanIds.set(event.scanId, now);
      if (seenScanIds.size > MAX_SCAN_IDS) {
        const firstKey = seenScanIds.keys().next().value;
        if (firstKey !== undefined) seenScanIds.delete(firstKey);
      }
    }
    const bypass = dedupeBypass?.(event) === true;
    if (!bypass && lastEmit && lastEmit.code === event.code && now - lastEmit.at < DEDUPE_MS) {
      return;
    }
    lastEmit = { code: event.code, at: now };
    // Run the privileged router listener FIRST so consumed-event marking
    // happens before any legacy bus consumer sees the event. Without this,
    // listener-registration order would race the router and break the
    // double-dispatch guard.
    if (routerListener) {
      try {
        routerListener(event);
      } catch (err) {
        console.error("[scanBus] router listener error", err);
      }
    }
    for (const fn of Array.from(listeners)) {
      try {
        fn(event);
      } catch (err) {
        console.error("[scanBus] listener error", err);
      }
    }
  },
  /**
   * Install the single privileged router listener. Called by `scanRouter`;
   * not for direct consumer use. Always runs before normal `on` listeners.
   */
  setRouter(fn: ((event: ScanEvent) => void) | null): void {
    routerListener = fn;
  },
  /**
   * Install a predicate that lets registered targets opt out of the
   * cross-source dedupe. Called by `scanRouter` on install; not for
   * direct consumer use.
   */
  setDedupeBypass(fn: ((event: ScanEvent) => boolean) | null): void {
    dedupeBypass = fn;
  },
  onProgress(listener: ProgressListener): () => void {
    progressListeners.add(listener);
    return () => progressListeners.delete(listener);
  },
  emitProgress(progress: ScanProgress | null): void {
    for (const fn of Array.from(progressListeners)) {
      try {
        fn(progress);
      } catch (err) {
        console.error("[scanBus] progress listener error", err);
      }
    }
  },
  /** For tests. */
  _clear(): void {
    listeners.clear();
    progressListeners.clear();
    lastEmit = null;
    dedupeBypass = null;
    routerListener = null;
    seenScanIds.clear();
  },
};
