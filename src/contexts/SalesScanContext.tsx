/**
 * SalesScanContext — context-aware scan routing for the Sales workspace.
 *
 * One long-lived `useScanTarget` registration is mounted by `SalesLayout`,
 * so every barcode scanned while an operator is inside Sales flows through
 * here regardless of which DOM element happens to be focused. Two consumers:
 *
 *   - An open invoice dialog (Create or Edit) registers a controller via
 *     `useSalesScanController(fn)`. Resolved scans land in that controller
 *     directly — line entry stops depending on input focus.
 *   - The Invoices list page registers an "open draft" handler via
 *     `useSalesOpenDraftHandler(fn)`. When no controller is active AND
 *     `mode === "rapid"`, the next scan opens a Create dialog seeded with
 *     the scanned product. In `browse` mode an inert hint is emitted.
 *
 * A 5-deep / 500 ms FIFO buffers scans that arrive while the dialog is
 * mounting and replays them on the next animation frame after the
 * controller registers (closes the dialog-mount blind spot).
 *
 * Mode is persisted in localStorage keyed by `business_id:user_id` so each
 * operator's preference survives reload but does not leak across logins.
 *
 * See ADR-0018 and `.lovable/plan.md`.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useResolveBarcode, useScanTarget, type ResolvedScan } from "@/hooks/scanner";
import { useActiveScanContext } from "@/hooks/pos/useActiveScanContext";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranches } from "@/hooks/useBranches";
import { useAuth } from "@/contexts/AuthContext";
import { scanFeedbackBus } from "@/services/scanner";
import { useToast } from "@/hooks/use-toast";
import { normalizeError } from "@/services/resilience";
import { decideReplayPolicy } from "@/services/scanner/replayPolicy";
import { dialogReadyBus } from "@/services/scanner/dialogReadyBus";

type ScanController = (resolved: ResolvedScan) => void;
type OpenDraftHandler = (resolved: ResolvedScan) => void;
export type SalesScanMode = "rapid" | "browse";

export interface InboxItem {
  id: string;
  resolved: ResolvedScan;
  code: string;
  decodedAt: number | null;
  receivedAt: number;
}

interface SalesScanContextValue {
  registerDraftController: (fn: ScanController) => () => void;
  registerOpenDraftHandler: (fn: OpenDraftHandler) => () => void;
  /** Snapshot getter — non-reactive. Use `useSalesHasActiveDraft` for subscribe. */
  hasActiveDraft: () => boolean;
  /** Subscribe to active-draft changes. */
  subscribeActiveDraft: (cb: () => void) => () => void;
  mode: SalesScanMode;
  setMode: (m: SalesScanMode) => void;
  /** Pending stale-replay scans awaiting operator review (Plan P2). */
  inbox: InboxItem[];
  acceptInboxItem: (id: string) => void;
  discardInboxItem: (id: string) => void;
  acceptAllInbox: () => void;
  clearInbox: () => void;
}

const SalesScanContext = createContext<SalesScanContextValue | null>(null);

interface BufferedScan {
  resolved: ResolvedScan;
  ts: number;
}

const QUEUE_MAX = 5;
const QUEUE_TTL_MS = 500;
const MODE_STORAGE_PREFIX = "sales.scan.mode";

function modeStorageKey(businessId: string | null, userId: string | null) {
  return `${MODE_STORAGE_PREFIX}:${businessId ?? "_"}:${userId ?? "_"}`;
}

function readPersistedMode(key: string): SalesScanMode {
  try {
    const raw = localStorage.getItem(key);
    return raw === "rapid" ? "rapid" : "browse";
  } catch {
    return "browse";
  }
}

export function SalesScanProvider({ children }: { children: ReactNode }) {
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranches();
  const { user } = useAuth();
  const { resolveTagged } = useResolveBarcode(currentBusiness?.id, currentBranch?.id ?? null);
  const { toast } = useToast();

  // Group C #3 — anchor every router-dispatched scan in this workspace to
  // `scan_events` via the `workspace_id` audit lane. Resolved org comes
  // from the caller's active business; branch is left to the row-level
  // join. Cleared automatically on provider unmount.
  useActiveScanContext({ workspace_id: "sales" });

  const controllerRef = useRef<ScanController | null>(null);
  const openDraftRef = useRef<OpenDraftHandler | null>(null);
  const queueRef = useRef<BufferedScan[]>([]);
  const inFlightCodesRef = useRef<Set<string>>(new Set());

  // Active-draft subscribers (for useSyncExternalStore).
  const activeDraftListenersRef = useRef<Set<() => void>>(new Set());
  const notifyActiveDraft = useCallback(() => {
    activeDraftListenersRef.current.forEach((cb) => {
      try { cb(); } catch (err) { console.error("[SalesScanContext] listener", err); }
    });
  }, []);

  // Mode state — persisted per (business, user).
  const storageKey = modeStorageKey(currentBusiness?.id ?? null, user?.id ?? null);
  const [mode, setModeState] = useState<SalesScanMode>(() => readPersistedMode(storageKey));
  // Re-hydrate when the active business/user changes.
  useEffect(() => {
    setModeState(readPersistedMode(storageKey));
  }, [storageKey]);
  const setMode = useCallback(
    (m: SalesScanMode) => {
      setModeState(m);
      try { localStorage.setItem(storageKey, m); } catch { /* noop */ }
    },
    [storageKey],
  );

  const drainQueue = useCallback(() => {
    const ctrl = controllerRef.current;
    if (!ctrl) return;
    const now = Date.now();
    const q = queueRef.current;
    while (q.length > 0) {
      const item = q.shift()!;
      if (now - item.ts > QUEUE_TTL_MS) continue;
      try { ctrl(item.resolved); }
      catch (err) { console.error("[SalesScanContext] controller error", err); }
    }
  }, []);

  const registerDraftController = useCallback(
    (fn: ScanController) => {
      controllerRef.current = fn;
      notifyActiveDraft();
      // Plan P5: signal scan-to-open callers that the dialog has
      // finished mounting AND registered its controller. Replaces the
      // historical 600 ms race-y `setTimeout` guard.
      dialogReadyBus.signal("sales.draft");
      requestAnimationFrame(() => drainQueue());
      return () => {
        if (controllerRef.current === fn) {
          controllerRef.current = null;
          notifyActiveDraft();
        }
      };
    },
    [drainQueue, notifyActiveDraft],
  );

  const registerOpenDraftHandler = useCallback((fn: OpenDraftHandler) => {
    openDraftRef.current = fn;
    return () => {
      if (openDraftRef.current === fn) openDraftRef.current = null;
    };
  }, []);

  const hasActiveDraft = useCallback(() => controllerRef.current !== null, []);
  const subscribeActiveDraft = useCallback((cb: () => void) => {
    activeDraftListenersRef.current.add(cb);
    return () => { activeDraftListenersRef.current.delete(cb); };
  }, []);

  const dispatch = useCallback(
    (resolved: ResolvedScan) => {
      const ctrl = controllerRef.current;
      if (ctrl) {
        try { ctrl(resolved); }
        catch (err) { console.error("[SalesScanContext] controller error", err); }
        return;
      }
      // No controller. If an open-draft handler is registered AND we're in
      // rapid mode, hand the scan straight to it — the dialog will seed
      // `initialScan` and apply the line once. We do NOT also queue the
      // scan: that would double-apply (queue replay + initialScan effect).
      const open = openDraftRef.current;
      if (open && mode === "rapid") {
        try { open(resolved); }
        catch (err) { console.error("[SalesScanContext] open-draft error", err); }
        return;
      }
      // Browse mode (or no handler) — queue briefly in case a dialog is
      // mid-mount, but no destructive toast. The scanner panel inside a
      // newly-opened dialog will replay anything still fresh.
      const buf = queueRef.current;
      buf.push({ resolved, ts: Date.now() });
      while (buf.length > QUEUE_MAX) buf.shift();
    },
    [mode],
  );

  // -------- Stale-replay review inbox (Plan P2) --------
  const [inbox, setInbox] = useState<InboxItem[]>([]);
  const inboxIdRef = useRef(0);

  const enqueueInbox = useCallback(
    (resolved: ResolvedScan, code: string, decodedAt: number | null, receivedAt: number) => {
      setInbox((prev) => {
        // Cap at 50 to bound memory; oldest first when over cap.
        const next = [
          ...prev,
          {
            id: `inbox-${++inboxIdRef.current}`,
            resolved,
            code,
            decodedAt,
            receivedAt,
          },
        ];
        return next.length > 50 ? next.slice(next.length - 50) : next;
      });
    },
    [],
  );

  const acceptInboxItem = useCallback(
    (id: string) => {
      setInbox((prev) => {
        const item = prev.find((it) => it.id === id);
        if (item) dispatch(item.resolved);
        return prev.filter((it) => it.id !== id);
      });
    },
    [dispatch],
  );

  const discardInboxItem = useCallback((id: string) => {
    setInbox((prev) => prev.filter((it) => it.id !== id));
  }, []);

  const acceptAllInbox = useCallback(() => {
    setInbox((prev) => {
      for (const item of prev) dispatch(item.resolved);
      return [];
    });
  }, [dispatch]);

  const clearInbox = useCallback(() => setInbox([]), []);

  const handleScan = useCallback(
    async (code: string, decodedAt: number | undefined) => {
      const norm = code.trim();
      if (!norm || !currentBusiness?.id) return;
      if (inFlightCodesRef.current.has(norm)) return;
      inFlightCodesRef.current.add(norm);
      try {
        const result = await resolveTagged(norm);
        if (result.kind === "hit") {
          scanFeedbackBus.emit({
            kind: "ok", raw: norm, source: "field",
            workflow: "quantity", fieldLabel: "Sales workspace",
          });
          // Plan P2: route stale replays (decoded long before receive) into
          // the review drawer instead of mutating a live invoice draft.
          const receivedAt = Date.now();
          const policy = decideReplayPolicy({
            intent: "doc_author",
            decodedAt,
            receivedAt,
          });
          if (policy === "review_queue") {
            enqueueInbox(result.row, norm, decodedAt ?? null, receivedAt);
          } else {
            dispatch(result.row);
          }
          return;
        }
        if (result.kind === "miss") {
          scanFeedbackBus.emit({
            kind: "unknown", raw: norm, source: "field",
            workflow: "quantity", fieldLabel: "Sales workspace",
          });
          if (!controllerRef.current && mode === "browse") {
            toast({
              title: "Unknown barcode",
              description: `"${norm}" did not match any product.`,
              variant: "destructive",
            });
          }
          return;
        }
        scanFeedbackBus.emit({
          kind: "error", raw: norm, source: "field",
          workflow: "quantity", fieldLabel: "Sales workspace",
        });
        if (!controllerRef.current && mode === "browse") {
          toast({
            title: "Scanner lookup failed",
            description: normalizeError(result.err).message,
            variant: "destructive",
          });
        }
      } finally {
        inFlightCodesRef.current.delete(norm);
      }
    },
    [currentBusiness?.id, dispatch, enqueueInbox, mode, resolveTagged, toast],
  );

  useScanTarget({
    active: !!currentBusiness?.id,
    priority: 5,
    label: "SalesScanContext",
    workflow: "identity",
    intent: "doc_author",
    onScan: (event) => { void handleScan(event.code, event.decodedAt); },
  });

  useEffect(() => {
    const t = window.setInterval(() => {
      const now = Date.now();
      queueRef.current = queueRef.current.filter((b) => now - b.ts <= QUEUE_TTL_MS);
    }, 1000);
    return () => window.clearInterval(t);
  }, []);

  const value = useMemo<SalesScanContextValue>(
    () => ({
      registerDraftController,
      registerOpenDraftHandler,
      hasActiveDraft,
      subscribeActiveDraft,
      mode,
      setMode,
      inbox,
      acceptInboxItem,
      discardInboxItem,
      acceptAllInbox,
      clearInbox,
    }),
    [
      registerDraftController, registerOpenDraftHandler,
      hasActiveDraft, subscribeActiveDraft, mode, setMode,
      inbox, acceptInboxItem, discardInboxItem, acceptAllInbox, clearInbox,
    ],
  );

  return <SalesScanContext.Provider value={value}>{children}</SalesScanContext.Provider>;
}

export function useSalesScanController(controller: ScanController | null) {
  const ctx = useContext(SalesScanContext);
  useEffect(() => {
    if (!ctx || !controller) return;
    return ctx.registerDraftController(controller);
  }, [ctx, controller]);
}

export function useSalesOpenDraftHandler(handler: OpenDraftHandler | null) {
  const ctx = useContext(SalesScanContext);
  useEffect(() => {
    if (!ctx || !handler) return;
    return ctx.registerOpenDraftHandler(handler);
  }, [ctx, handler]);
}

/** Reactive — true while a Create/Edit invoice dialog has registered a controller. */
export function useSalesHasActiveDraft(): boolean {
  const ctx = useContext(SalesScanContext);
  return useSyncExternalStore(
    useCallback((cb) => (ctx ? ctx.subscribeActiveDraft(cb) : () => {}), [ctx]),
    useCallback(() => (ctx ? ctx.hasActiveDraft() : false), [ctx]),
    () => false,
  );
}

export function useSalesScanMode() {
  const ctx = useContext(SalesScanContext);
  return {
    mode: ctx?.mode ?? "browse",
    setMode: ctx?.setMode ?? (() => {}),
    available: !!ctx,
  } as const;
}

export function useSalesScanContext() {
  return useContext(SalesScanContext);
}
