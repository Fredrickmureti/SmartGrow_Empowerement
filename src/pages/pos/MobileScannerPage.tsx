/**
 * MobileScannerPage — phone-side scanner UI.
 *
 * Mounted at `/scan/:token` (top-level, auth-only — NOT inside the POS
 * subscription gate, so Inventory/Sales pairings work for non-POS tenants).
 * `/pos/scan/:token` is kept only as a legacy redirect for QRs already in
 * the wild (see LegacyScanRedirect in App.tsx).
 *
 * The phone:
 *   1. Claims the pairing token via `pos_claim_scanner_pairing`.
 *   2. Subscribes to the per-register Realtime channel (`pos:scan:<id>`)
 *      with presence so the terminal shows "Mobile scanner connected".
 *   3. Opens the camera using `BarcodeDetector` when available,
 *      falling back to ZXing on Safari/iOS.
 *   4. For every decoded barcode, broadcasts `{ code, seq, decoded_at }`.
 *
 * The phone NEVER reads or mutates the cart. It only emits strings.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  Loader2, Camera, CameraOff, AlertTriangle, CheckCircle2,
  Smartphone, RefreshCw, XCircle, Ban, Flashlight, Keyboard,
  ChevronUp, ChevronDown, Activity, Volume2, VolumeX,
  Tag, Hash, ClipboardList, PackageCheck, Timer, Gauge, Zap,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  safeParseAck,
  safeParseRevoke,
  SCAN_EVENTS,
  type AckWorkflow,
  type RevokeReason,
} from "@/services/scanner/ackPayload";
import { feedbackTones, toneForAck } from "@/services/scanner/feedbackTones";
import {
  appendLatencySample,
  deriveCockpitMetrics,
} from "@/services/scanner/cockpitMetrics";
import {
  useScannerHealth,
  type ScannerChannelState,
  type ScannerHealth,
} from "@/hooks/scanner/useScannerHealth";
import { PhoneShortcutsOverlay } from "@/components/scanner/PhoneShortcutsOverlay";
import { useScannerSessionRevocation } from "@/hooks/scanner/useScannerSessionRevocation";
import {
  enqueueScan,
  drainQueue,
  type QueuedScan,
} from "@/services/scanner/replayQueue";
import { useNativeScanner } from "@/hooks/scanner/useNativeScanner";
import { useBatteryStatus } from "@/hooks/scanner/useBatteryStatus";
import { loadCockpit, saveCockpit } from "@/services/scanner/cockpitPersistence";
import {
  resolveDeviceId,
  getTrustToken,
  setTrustToken,
  clearTrustToken,
} from "@/services/scanner/deviceIdentity";
import {
  promoteOnInbound,
  DOWN_FLIP_DELAY_MS,
} from "@/services/scanner/channelStateTruth";
import { useQrRepairScan } from "@/hooks/scanner/useQrRepairScan";
import { BatteryLow, BatteryMedium, BatteryFull, BatteryCharging } from "lucide-react";

interface RecentScan {
  id: number;
  code: string;
  kind: "pending" | "ok" | "weighted" | "unknown" | "error";
  detail?: string | null;
  symbology?: string | null;
  at: number;
}

interface ClaimResult {
  register_id: string;
  business_id: string;
  branch_id: string;
  organization_id: string;
  session_id: string | null;
  channel_key: string;
  register_name: string;
}

type Status = "loading" | "ready" | "scanning" | "error";

function detectDeviceLabel(): string {
  if (typeof navigator === "undefined") return "Mobile device";
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) {
    const m = ua.match(/Android[^;]*;\s*([^)]+)/);
    return m ? m[1].trim() : "Android device";
  }
  return "Mobile device";
}

/**
 * Stable per-device id (Plan P4a).
 *
 * Persisted in `localStorage` so a phone refresh (the historical
 * "burned token" scenario) preserves identity end-to-end: desk
 * `(device_id, seq)` dedupe stays consistent, the existing pairing
 * remains valid, and the operator never has to re-pair.
 *
 * Migration: if a legacy `sessionStorage` value is present (pre-P4a),
 * it is carried forward into `localStorage` and counted via a
 * `scanner.refresh_burned_token` telemetry marker.
 */
function getDeviceId(): string {
  if (typeof window === "undefined") return "phone";
  try {
    const res = resolveDeviceId(window.localStorage, window.sessionStorage);
    if (res.refreshBurnedToken) {
      console.info("[scanner.telemetry] refresh_burned_token", {
        source: res.source,
      });
    }
    return res.id;
  } catch {
    // Storage disabled (private mode etc.). Fall back to per-session UUID.
    return crypto.randomUUID?.() ?? `phone-${Date.now()}`;
  }
}

/** Resolve pairing token from URL fragment (`/scan#TOKEN`) or path param. */
function useToken(): string | undefined {
  const { token } = useParams<{ token: string }>();
  const fragment = typeof window !== "undefined" ? window.location.hash.replace(/^#/, "") : "";
  return fragment || token;
}

export default function MobileScannerPage() {
  const token = useToken();
  const navigate = useNavigate();
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<string | null>(null);
  const [claim, setClaim] = useState<ClaimResult | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [authed, setAuthed] = useState(false);
  const [online, setOnline] = useState(typeof navigator === "undefined" ? true : navigator.onLine);
  const [lastScan, setLastScan] = useState<{ code: string; at: number } | null>(null);
  const [scanCount, setScanCount] = useState(0);
  const [manualCode, setManualCode] = useState("");
  const [torchOn, setTorchOn] = useState(false);
  const [ackToast, setAckToast] = useState<{ kind: "ok" | "weighted" | "unknown" | "error"; code: string; detail?: string | null; at: number } | null>(null);
  const [channelState, setChannelState] = useState<ScannerChannelState>("connecting");
  const [workflowChip, setWorkflowChip] = useState<{ workflow?: AckWorkflow; label?: string } | null>(null);
  const [revokeReason, setRevokeReason] = useState<RevokeReason | null>(null);
  const [muted, setMuted] = useState<boolean>(() => feedbackTones.isMuted());

  // --- S1/S2 cockpit state ---
  const [recent, setRecent] = useState<RecentScan[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [lastContactAt, setLastContactAt] = useState<number>(Date.now());
  const recentIdRef = useRef(0);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const seqRef = useRef(0);
  const lastBroadcastRef = useRef<{ code: string; at: number } | null>(null);
  const detectorRef = useRef<any>(null);
  const zxingControlsRef = useRef<{ stop: () => void } | null>(null);
  const rafRef = useRef<number | null>(null);
  const wakeLockRef = useRef<any>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);
  /**
   * Debounce timer for the "reconnecting" pill. We do not flip the
   * cockpit to "reconnecting" the instant Supabase Realtime fires a
   * transient CLOSED — that happens on every backgrounding and JWT
   * refresh and disappears within a frame. Only after
   * `DOWN_FLIP_DELAY_MS` of continued silence (no SUBSCRIBED, no
   * inbound traffic) do we surface the reconnecting state.
   */
  const downFlipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * Phone-side replay buffer. Scans done while the realtime channel is
   * `connecting`/`reconnecting` are queued here (FIFO, cap 50, drop-oldest)
   * and drained in order on the next `SUBSCRIBED` event. The desk-side
   * `useScanChannel`/`usePOSScannerChannel` dedupe by `(device_id, seq)`
   * so a flush after a short reconnect cannot double-add anything. Queue
   * semantics live in `@/services/scanner/replayQueue` and are unit-tested
   * in `src/test/scanner/replay-buffer.test.ts`.
   */
  const pendingScansRef = useRef<QueuedScan[]>([]);
  const [queueDepth, setQueueDepth] = useState(0);
  const queueStateRef = useRef<{ fullToastShown: boolean }>({ fullToastShown: false });
  const workflowChipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // --- Cockpit metrics (Track 2) ---
  const [subscribedAt, setSubscribedAt] = useState<number | null>(null);
  const [scanTimestamps, setScanTimestamps] = useState<number[]>([]);
  const [latencySamples, setLatencySamples] = useState<number[]>([]);
  const [reconnectingSince, setReconnectingSince] = useState<number | null>(null);
  const [reconnectDisabledUntil, setReconnectDisabledUntil] = useState<number>(0);
  const [metricsTick, setMetricsTick] = useState(0);
  const subscribeOnceRef = useRef<(() => void) | null>(null);
  // --- Recent rail filter (Track 3) ---
  const [recentFilter, setRecentFilter] = useState<"all" | "errors" | "unknown">("all");

  const deviceLabel = useMemo(() => detectDeviceLabel(), []);
  const deviceId = useMemo(() => getDeviceId(), []);
  const battery = useBatteryStatus();
  const persistKey = claim?.session_id || claim?.register_id || null;

  // -------- Rehydrate cockpit snapshot from sessionStorage --------
  // Runs once per pairing session; restores recent rail + counters so
  // an accidental refresh during a long warehouse shift does not lose
  // the audit trail. New pairings start clean.
  const rehydratedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!persistKey || rehydratedRef.current === persistKey) return;
    rehydratedRef.current = persistKey;
    const snap = loadCockpit(persistKey);
    if (!snap) return;
    setRecent(snap.recent);
    setScanCount(snap.scanCount);
    setScanTimestamps(snap.scanTimestamps);
    setLatencySamples(snap.latencySamples);
    recentIdRef.current = Math.max(recentIdRef.current, snap.nextId);
  }, [persistKey]);

  // -------- Persist cockpit snapshot (debounced 500ms) --------
  useEffect(() => {
    if (!persistKey) return;
    const id = setTimeout(() => {
      saveCockpit(persistKey, {
        recent,
        scanCount,
        scanTimestamps,
        latencySamples,
        nextId: recentIdRef.current,
      });
    }, 500);
    return () => clearTimeout(id);
  }, [persistKey, recent, scanCount, scanTimestamps, latencySamples]);



  // -------- Auth check --------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase.auth.getSession();
      if (cancelled) return;
      setAuthed(!!data.session);
      setAuthChecked(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // -------- Online/offline --------
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  // -------- Claim pairing --------
  useEffect(() => {
    if (!authChecked || !authed) return;
    let cancelled = false;

    // Silent reclaim using this device's stored trust token (valid for the
    // 30-day trust window). Returns true if it reconnected and set the claim,
    // false otherwise. Never surfaces an error itself — the caller decides.
    const trySilentReclaim = async (): Promise<boolean> => {
      const trust = getTrustToken();
      if (!trust) return false;
      const rec = await supabase.rpc(
        "scanner_reclaim_session" as any,
        { p_device_id: deviceId, p_trust_token: trust } as any,
      );
      if (cancelled) return true; // unmounted; treat as handled
      if (rec.error || !Array.isArray(rec.data) || rec.data.length === 0) {
        const msg = String(rec.error?.message || "trust_invalid");
        if (/trust_(invalid|revoked|expired)/.test(msg)) {
          clearTrustToken();
        }
        console.info("[scanner.telemetry] silent_reclaim_failed", { reason: msg });
        return false;
      }
      const r = rec.data[0] as any;
      if (r.new_trust_token) setTrustToken(r.new_trust_token as string);
      setClaim({
        register_id: r.session_id,
        business_id: r.business_id,
        branch_id: r.branch_id,
        organization_id: r.organization_id,
        session_id: r.session_id,
        channel_key: r.channel_topic,
        register_name: r.label || "Trusted scanner",
      });
      setStatus("ready");
      console.info("[scanner.telemetry] silent_reclaim_ok");
      return true;
    };

    (async () => {
      setStatus("loading");
      // P4b — silent reclaim path. If no fresh QR token was provided but
      // this device has a stored trust token from a previous pairing,
      // try `scanner_reclaim_session` first. On success the operator
      // never sees the pairing screen.
      if (!token) {
        if (await trySilentReclaim()) return;
        if (cancelled) return;
        setError(
          getTrustToken()
            ? "Trusted-device reconnect failed. Re-pair from the terminal."
            : "Missing pairing token",
        );
        setStatus("error");
        return;
      }
      // Try POS register pairing first; fall back to scanner session pairing.
      let row: ClaimResult | null = null;
      const posRes = await supabase.rpc(
        "pos_claim_scanner_pairing" as any,
        { p_token: token, p_device_label: deviceLabel } as any,
      );
      if (!posRes.error && Array.isArray(posRes.data) && posRes.data.length > 0) {
        row = posRes.data[0] as ClaimResult;
      } else {
        const sessRes = await supabase.rpc(
          "claim_scanner_session_pairing" as any,
          { p_token: token, p_device_label: deviceLabel } as any,
        );
        if (cancelled) return;
        if (sessRes.error || !Array.isArray(sessRes.data) || sessRes.data.length === 0) {
          // The URL token is dead (already claimed / used / expired / invalid).
          // This is the common "left the page and came back" case: the browser
          // reopens the same /pos/scan/:token URL with a now-burned token. Before
          // failing, fall back to silent reclaim using the stored trust token so
          // a returning phone reconnects without forcing a fresh QR scan.
          const failMsg = String(
            sessRes.error?.message || posRes.error?.message || "Invalid pairing token",
          );
          if (/claim|used|expired|invalid/i.test(failMsg) && (await trySilentReclaim())) {
            return;
          }
          if (cancelled) return;
          setError(failMsg);
          setStatus("error");
          return;
        }
        const s = sessRes.data[0] as any;
        row = {
          register_id: s.session_id,
          business_id: s.business_id,
          branch_id: s.branch_id,
          organization_id: s.organization_id,
          session_id: s.session_id,
          channel_key: s.channel_key,
          register_name: s.label || "Scanner session",
        };
      }
      if (cancelled) return;
      setClaim(row);
      setStatus("ready");
      // Strip the single-use token from the URL now that it's claimed. A later
      // return/refresh then mounts token-less and routes through the silent
      // reclaim branch above instead of re-hitting this now-burned token.
      //
      // CRITICAL: Use history.replaceState — NOT navigate(). Any navigate()
      // re-enters the route tree; navigating to "/scan" (or the old
      // "/pos/scan") with no token does not match `/scan/:token` and falls
      // through to gated subtrees, bouncing non-POS tenants pairing from
      // Inventory/Sales straight to /dashboard. Replacing the URL in place
      // keeps the component mounted and preserves the realtime channel.
      if (token && typeof window !== "undefined") {
        try {
          window.history.replaceState({}, "", "/scan");
        } catch {
          /* ignore — non-fatal, URL just keeps the burned token */
        }
      }
      // P4b — mint / rotate a trust token so future refreshes can use the
      // silent-reclaim path above. Failure here is non-fatal: the
      // operator will simply have to re-scan a QR if the phone refreshes
      // before the next successful issue.
      if (row?.session_id) {
        const iss = await supabase.rpc(
          "scanner_issue_trust" as any,
          {
            p_session_id: row.session_id,
            p_device_id: deviceId,
            p_device_label: deviceLabel,
          } as any,
        );
        if (!iss.error && Array.isArray(iss.data) && iss.data.length > 0) {
          const t = (iss.data[0] as any)?.trust_token;
          if (typeof t === "string" && t.length > 0) setTrustToken(t);
        } else if (iss.error) {
          console.info("[scanner.telemetry] issue_trust_failed", {
            reason: iss.error.message,
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authChecked, authed, token, deviceLabel, deviceId, navigate]);


  // -------- Channel subscribe + presence --------
  useEffect(() => {
    if (!claim) return;
    let disposed = false;

    const noteInboundTraffic = () => {
      setLastContactAt(Date.now());
      if (downFlipTimerRef.current) {
        clearTimeout(downFlipTimerRef.current);
        downFlipTimerRef.current = null;
      }
      setChannelState((s) => promoteOnInbound(s));
    };

    const subscribeOnce = () => {
      if (disposed) return;
      setChannelState((s) => {
        if (s === "revoked") return s;
        // Don't visibly flip to "reconnecting" while we re-subscribe.
        // The debounce timer (armed on the previous CLOSED) will surface
        // it if the silence persists past DOWN_FLIP_DELAY_MS.
        if (reconnectAttemptRef.current === 0) return "connecting";
        return s;
      });
      const channel = supabase.channel(claim.channel_key, {
        config: {
          broadcast: { ack: false, self: false },
          presence: { key: deviceId },
          private: true,
        } as any,
      });
      channelRef.current = channel;

      channel
        .on("broadcast", { event: SCAN_EVENTS.ack }, ({ payload }) => {
          const p = safeParseAck(payload);
          if (!p) return;
          const kind = p.kind;
          setAckToast({ kind, code: p.code, detail: p.detail ?? null, at: Date.now() });
          noteInboundTraffic();
          // Track 2 — latency sample = ACK time - decoded_at lookup from
          // our pending recent[]. Use the matching pending row's `at` as
          // the decoded timestamp.
          setRecent((prevForLatency) => {
            const pendingRow = prevForLatency.find((r) => r.code === p.code && r.kind === "pending");
            if (pendingRow) {
              const rtt = Date.now() - pendingRow.at;
              setLatencySamples((s) => appendLatencySample(s, rtt));
            }
            return prevForLatency;
          });
          if (p.workflow || p.field_label) {
            setWorkflowChip({ workflow: p.workflow, label: p.field_label });
          }
          setRecent((prev) => {
            const idx = prev.findIndex((r) => r.code === p.code && r.kind === "pending");
            if (idx >= 0) {
              const next = prev.slice();
              next[idx] = { ...next[idx], kind: kind as RecentScan["kind"], detail: p.detail ?? null, at: Date.now() };
              return next;
            }
            return [{ id: ++recentIdRef.current, code: p.code, kind: kind as RecentScan["kind"], detail: p.detail ?? null, at: Date.now() }, ...prev].slice(0, 8);
          });
          feedbackTones.play(toneForAck(kind));
        })
        .on("broadcast", { event: SCAN_EVENTS.revoke }, ({ payload }) => {
          if (disposed) return;
          const parsed = safeParseRevoke(payload);
          setRevokeReason(parsed?.reason ?? "manual");
          // Cancel any pending down-flip — revoked is terminal and takes
          // precedence over reconnecting.
          if (downFlipTimerRef.current) {
            clearTimeout(downFlipTimerRef.current);
            downFlipTimerRef.current = null;
          }
          setChannelState("revoked");
          feedbackTones.play("disconnect");
          stopCameraInternal();
        })
        .on("broadcast", { event: SCAN_EVENTS.ping }, ({ payload }) => {
          const ch = channelRef.current;
          if (!ch) return;
          const id = (payload as any)?.id;
          const pingAt = (payload as any)?.at;
          if (typeof id !== "string" || typeof pingAt !== "number") return;
          noteInboundTraffic();
          void ch.send({
            type: "broadcast",
            event: SCAN_EVENTS.pong,
            payload: { id, ping_at: pingAt, at: Date.now() },
          });
        })
        .subscribe(async (state) => {
          if (disposed) return;
          if (state === "SUBSCRIBED") {
            reconnectAttemptRef.current = 0;
            // Cancel any armed down-flip — we are healthy again.
            if (downFlipTimerRef.current) {
              clearTimeout(downFlipTimerRef.current);
              downFlipTimerRef.current = null;
            }
            setChannelState("connected");
            setLastContactAt(Date.now());
            setSubscribedAt((prev) => prev ?? Date.now());
            setReconnectingSince(null);
            await channel.track({
              user_id: deviceId,
              device_label: deviceLabel,
              online_at: new Date().toISOString(),
            });
            // Drain replay buffer FIFO via the shared helper (cap-50, drop-
            // oldest, one-shot toast latch). Desk-side dedupes by
            // (device_id, seq) so a flush after a short reconnect is a true
            // no-op when a duplicate slips through.
            const queued = drainQueue(pendingScansRef.current, queueStateRef.current);
            setQueueDepth(0);
            if (queued.length > 0) {
              for (const item of queued) {
                try {
                  await channel.send({
                    type: "broadcast",
                    event: SCAN_EVENTS.scan,
                    payload: { ...item, device_id: deviceId },
                  });
                } catch {
                  // If a single replay fails, requeue the rest and break.
                  pendingScansRef.current.unshift(item);
                  setQueueDepth(pendingScansRef.current.length);
                  break;
                }
              }
              setAckToast({
                kind: "ok",
                code: `${queued.length - pendingScansRef.current.length} queued scan(s) sent`,
                detail: null,
                at: Date.now(),
              });
            }
          } else if (state === "CHANNEL_ERROR" || state === "CLOSED" || state === "TIMED_OUT") {
            if (disposed) return;
            try { supabase.removeChannel(channel); } catch { /* ignore */ }
            channelRef.current = null;
            reconnectAttemptRef.current += 1;
            const delay = Math.min(15000, 500 * 2 ** Math.min(5, reconnectAttemptRef.current));
            // Schedule the actual re-subscribe immediately (we want to
            // recover as fast as possible) but DEBOUNCE the visible
            // "reconnecting" state — if SUBSCRIBED or any inbound event
            // wins the race, the timer is cancelled and the operator
            // never sees a phantom flap.
            if (downFlipTimerRef.current) clearTimeout(downFlipTimerRef.current);
            downFlipTimerRef.current = setTimeout(() => {
              downFlipTimerRef.current = null;
              setChannelState((s) => (s === "revoked" || s === "connected" ? s : "reconnecting"));
              setReconnectingSince(Date.now() + delay);
            }, DOWN_FLIP_DELAY_MS);
            reconnectTimerRef.current = setTimeout(subscribeOnce, delay);
          }
        });
    };

    // Internal stopCamera that doesn't depend on the outer stopCamera identity.
    const stopCameraInternal = () => {
      if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
      if (zxingControlsRef.current) { try { zxingControlsRef.current.stop(); } catch { /* ignore */ } zxingControlsRef.current = null; }
      if (streamRef.current) { for (const t of streamRef.current.getTracks()) t.stop(); streamRef.current = null; }
      if (wakeLockRef.current) { try { wakeLockRef.current.release(); } catch { /* ignore */ } wakeLockRef.current = null; }
      setTorchOn(false);
    };

    subscribeOnce();
    subscribeOnceRef.current = subscribeOnce;

    return () => {
      disposed = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (downFlipTimerRef.current) { clearTimeout(downFlipTimerRef.current); downFlipTimerRef.current = null; }
      if (channelRef.current) { try { supabase.removeChannel(channelRef.current); } catch { /* ignore */ } }
      channelRef.current = null;
      subscribeOnceRef.current = null;
    };
  }, [claim, deviceLabel, deviceId]);

  // Auto-clear ack toast (2s — long enough to read at warehouse arm's-length)
  useEffect(() => {
    if (!ackToast) return;
    const id = setTimeout(() => setAckToast(null), 2000);
    return () => clearTimeout(id);
  }, [ackToast]);

  // Mute toggle — keep local state mirrored from the bus (also drives a 1 Hz
  // tick replacement: the shared health hook re-renders on its own).
  useEffect(() => feedbackTones.onMutedChange(setMuted), []);

  // Auto-clear workflow chip 30 s after the last ACK refresh so a stale
  // workflow context never lies about the desk's current focus target.
  useEffect(() => {
    if (!workflowChip) return;
    if (workflowChipTimerRef.current) clearTimeout(workflowChipTimerRef.current);
    workflowChipTimerRef.current = setTimeout(() => setWorkflowChip(null), 30_000);
    return () => {
      if (workflowChipTimerRef.current) clearTimeout(workflowChipTimerRef.current);
    };
  }, [workflowChip]);

  // Clear workflow chip immediately when the channel goes unhealthy so
  // the operator never sees a stale "Identity · SKU-123" while the
  // realtime link is degraded / down / revoked.
  useEffect(() => {
    if (channelState !== "connected" && workflowChip) {
      setWorkflowChip(null);
    }
  }, [channelState, workflowChip]);


  // Health pill — single derivation shared with the desk-side dialog.
  const { health, lastContactAgo } = useScannerHealth({
    online,
    channelState,
    lastContactAt,
  });

  // Track 2 — 1 Hz tick so uptime/scan-rate/countdown re-render.
  useEffect(() => {
    const id = setInterval(() => setMetricsTick((t) => (t + 1) & 0xffff), 1000);
    return () => clearInterval(id);
  }, []);

  const metricsNow = Date.now();
  // Reference tick to keep the dependency live without a lint suppression.
  void metricsTick;
  const cockpit = deriveCockpitMetrics({
    subscribedAt,
    scanTimestamps,
    latencySamples,
    now: metricsNow,
  });
  const reconnectCountdownS = reconnectingSince
    ? Math.max(0, Math.ceil((reconnectingSince - metricsNow) / 1000))
    : 0;
  const reconnectDisabled = reconnectDisabledUntil > metricsNow;

  const handleManualReconnect = useCallback(() => {
    if (reconnectDisabled) return;
    setReconnectDisabledUntil(Date.now() + 2000);
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (channelRef.current) {
      try { supabase.removeChannel(channelRef.current); } catch { /* ignore */ }
      channelRef.current = null;
    }
    setChannelState("reconnecting");
    setReconnectingSince(Date.now() + 100);
    reconnectAttemptRef.current = 0;
    // Schedule next attempt immediately via the closure captured in the effect.
    const fn = subscribeOnceRef.current;
    if (fn) {
      reconnectTimerRef.current = setTimeout(fn, 100);
    }
  }, [reconnectDisabled]);

  // -------- Broadcast helper --------
  const broadcastScan = useCallback((code: string, meta?: { symbology?: string | null }) => {
    const norm = code.trim();
    if (!norm) return;
    // Local 400ms dedupe so a single barcode held in front of the camera
    // for multiple frames doesn't spam the channel.
    const now = Date.now();
    const last = lastBroadcastRef.current;
    if (last && last.code === norm && now - last.at < 400) return;
    lastBroadcastRef.current = { code: norm, at: now };

    const seq = ++seqRef.current;
    const ch = channelRef.current;
    const payload = { code: norm, seq, decoded_at: now, device_id: deviceId };

    if (!ch || channelState !== "connected") {
      // Queue for replay on next SUBSCRIBED via shared helper (cap-50,
      // drop-oldest, one-shot full-queue toast latch).
      const res = enqueueScan(
        pendingScansRef.current,
        { code: norm, seq, decoded_at: now },
        queueStateRef.current,
      );
      if (res.shouldNotifyFull) {
        setAckToast({ kind: "unknown", code: "Queue full — dropping oldest scans", detail: null, at: now });
      }
      setQueueDepth(res.depth);
    } else {
      void ch.send({ type: "broadcast", event: "scan", payload });
    }

    setLastScan({ code: norm, at: now });
    setScanCount((c) => c + 1);
    setRecent((prev) => [
      { id: ++recentIdRef.current, code: norm, kind: "pending" as const, symbology: meta?.symbology ?? null, at: now },
      ...prev,
    ].slice(0, 8));
    // Track 2 — keep last 5 minutes of timestamps (rolling-rate input).
    setScanTimestamps((prev) => {
      const cutoff = now - 5 * 60_000;
      const next = prev.filter((t) => t >= cutoff);
      next.push(now);
      return next;
    });
    if ("vibrate" in navigator) {
      try { navigator.vibrate(15); } catch { /* ignore */ }
    }
  }, [deviceId, channelState]);

  // -------- Native handheld scanner (Zebra DataWedge / Honeywell) --------
  // Operator toggle persisted per-tab; auto-on when a vendor engine is detected.
  const [useDeviceScanner, setUseDeviceScanner] = useState<boolean>(() => {
    if (typeof sessionStorage === "undefined") return true;
    return sessionStorage.getItem("pos.scanner.useDeviceScanner") !== "0";
  });
  useEffect(() => {
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.setItem("pos.scanner.useDeviceScanner", useDeviceScanner ? "1" : "0");
    }
  }, [useDeviceScanner]);
  const native = useNativeScanner({
    enabled: useDeviceScanner,
    onScan: useCallback(
      (scan) => {
        // Feed directly into the same dedupe/replay/telemetry pipeline as
        // camera + keyboard-wedge scans. Symbology rides along on the
        // local recent-rail row only — wire payload is unchanged.
        broadcastScan(scan.code, { symbology: scan.symbology });
      },
      [broadcastScan],
    ),
  });

  // -------- Camera + decoder --------
  const stopCamera = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (zxingControlsRef.current) {
      try { zxingControlsRef.current.stop(); } catch { /* ignore */ }
      zxingControlsRef.current = null;
    }
    // Drop the BarcodeDetector instance so the next start re-creates it
    // against the fresh stream (avoids stale detector pinned to a dead
    // video frame source on some Chromium builds).
    detectorRef.current = null;
    if (streamRef.current) {
      for (const t of streamRef.current.getTracks()) t.stop();
      streamRef.current = null;
    }
    // Detach the dead MediaStream from the <video> element. Leaving a
    // stopped srcObject in place wedges getUserMedia() reacquisition on
    // some browsers (notably iOS Safari and older Chromium) — the second
    // Start would silently no-op until the tab was re-entered.
    if (videoRef.current) {
      try { videoRef.current.pause(); } catch { /* ignore */ }
      try { videoRef.current.srcObject = null; } catch { /* ignore */ }
    }
    if (wakeLockRef.current) {
      try { wakeLockRef.current.release(); } catch { /* ignore */ }
      wakeLockRef.current = null;
    }
    setTorchOn(false);
    // CRITICAL: flip the state machine back to "ready" so the action dock
    // re-renders the Start button. Previously this was only reset by the
    // visibilitychange handler, which is why users had to leave and revisit
    // the tab before Start would work again.
    setStatus((prev) => (prev === "scanning" ? "ready" : prev));
  }, []);

  // -------- Proactive revoke signal (Plan P3) --------
  // Subscribe directly to our scanner_sessions row so an out-of-band revoke
  // (admin tooling, security timeout, org switch) flips us to "session ended"
  // without waiting for the next failed broadcast. The existing
  // broadcast-driven revoke path stays primary; this is the safety net.
  useScannerSessionRevocation({
    sessionId: claim?.session_id ?? null,
    onRevoked: () => {
      if (downFlipTimerRef.current) {
        clearTimeout(downFlipTimerRef.current);
        downFlipTimerRef.current = null;
      }
      setRevokeReason((r) => r ?? "manual");
      setChannelState("revoked");
      feedbackTones.play("disconnect");
      stopCamera();
      // P4b — if the session row was revoked out of band the trust
      // token is no longer useful; drop it so the next mount falls
      // through to a fresh QR pairing instead of looping reclaim.
      clearTrustToken();
    },
  });

  const startCamera = useCallback(async () => {
    if (!videoRef.current) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      streamRef.current = stream;
      videoRef.current.srcObject = stream;
      await videoRef.current.play().catch(() => undefined);

      // Try wake lock
      try {
        wakeLockRef.current = await (navigator as any).wakeLock?.request?.("screen");
      } catch { /* ignore */ }

      setStatus("scanning");

      // Prefer native BarcodeDetector (Chrome Android, Edge, modern Safari 17+)
      const BD = (window as any).BarcodeDetector;
      if (BD) {
        try {
          const formats = await BD.getSupportedFormats();
          detectorRef.current = new BD({
            formats: formats.length
              ? formats
              : ["ean_13", "ean_8", "code_128", "code_39", "qr_code", "upc_a", "upc_e", "itf"],
          });
        } catch {
          detectorRef.current = new BD();
        }

        const tick = async () => {
          if (!videoRef.current || !detectorRef.current) return;
          try {
            const results = await detectorRef.current.detect(videoRef.current);
            if (results && results.length > 0) {
              for (const r of results) {
                if (r.rawValue) broadcastScan(r.rawValue);
              }
            }
          } catch { /* frame may not be ready */ }
          rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
        return;
      }

      // Fallback: ZXing
      const { BrowserMultiFormatReader } = await import("@zxing/browser");
      const reader = new BrowserMultiFormatReader();
      const controls = await reader.decodeFromStream(
        stream,
        videoRef.current,
        (result) => {
          if (result) broadcastScan(result.getText());
        },
      );
      zxingControlsRef.current = controls as unknown as { stop: () => void };
    } catch (err: any) {
      console.error("[MobileScanner] camera error", err);
      setError(err?.message || "Unable to access the camera. Please grant camera permission.");
      setStatus("error");
    }
  }, [broadcastScan]);

  // Auto-stop on unmount
  useEffect(() => stopCamera, [stopCamera]);

  // Pause camera while the tab is backgrounded (saves battery, releases
  // wake-lock and camera light). Resume only if we were actively scanning.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden" && status === "scanning") {
        stopCamera();
        setStatus("ready");
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [status, stopCamera]);

  // -------- Torch toggle --------
  const toggleTorch = useCallback(async () => {
    const track = streamRef.current?.getVideoTracks?.()[0];
    if (!track) return;
    try {
      const caps: any = track.getCapabilities?.();
      if (!caps?.torch) return;
      const next = !torchOn;
      await track.applyConstraints({ advanced: [{ torch: next } as any] });
      setTorchOn(next);
    } catch { /* ignore */ }
  }, [torchOn]);

  // ----- In-app re-pair via QR rescan (hoisted above early returns) -----
  // These hooks MUST stay above any conditional return below — otherwise
  // React throws "Rendered more hooks than during the previous render"
  // the first time the splash screens stop firing (auth flips, claim
  // resolves). Hook order must be stable across every render path.
  const [repairScanOpen, setRepairScanOpen] = useState(false);
  const repairVideoRef = useRef<HTMLVideoElement | null>(null);
  const handleRepairToken = useCallback((nextToken: string) => {
    setRepairScanOpen(false);
    navigate(`/scan/${nextToken}`, { replace: true });
  }, [navigate]);
  const repairScan = useQrRepairScan({
    enabled: repairScanOpen,
    videoRef: repairVideoRef,
    onToken: handleRepairToken,
  });
  const showRepairOverlay =
    channelState === "revoked" ||
    (online && health === "down" && (lastContactAgo ?? 0) > 30);
  const handleRepair = () => {
    try {
      if (typeof BroadcastChannel !== "undefined") {
        const bc = new BroadcastChannel("scanner-workspace");
        bc.postMessage({ type: "reopen", label: claim?.register_name, at: Date.now() });
        bc.close();
      }
    } catch { /* ignore */ }
    setRepairScanOpen(true);
  };

  // -------- Render --------

  if (!authChecked) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }

  if (!authed) {
    const redirect = `/scan/${token ?? ""}`;
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background p-6 text-center">
        <Smartphone className="h-10 w-10 text-muted-foreground" />
        <div>
          <h1 className="text-xl font-semibold">Sign in to pair scanner</h1>
          <p className="text-sm text-muted-foreground">
            Sign in with the cashier account to use this phone as a scanner.
          </p>
        </div>
        <Button onClick={() => navigate(`/login?redirect=${encodeURIComponent(redirect)}`)}>
          Sign in
        </Button>
      </div>
    );
  }

  if (status === "error") {
    // In-app camera rescan — lets the operator scan a fresh pairing QR from
    // the terminal without leaving the app for their native camera.
    if (repairScanOpen) {
      return (
        <div className="flex min-h-screen flex-col bg-black text-white">
          <div className="relative flex-1 overflow-hidden bg-black">
            <video
              ref={repairVideoRef}
              playsInline
              muted
              className="h-full w-full object-cover"
            />
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <div className="relative h-56 w-56 rounded-2xl border-2 border-sky-400/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.55)]" />
            </div>
            <div className="absolute inset-x-0 top-3 z-10 mx-auto w-fit rounded-full bg-sky-500/90 px-3 py-1 text-xs font-semibold">
              Scan the new pairing QR
            </div>
            {repairScan.error && (
              <div className="absolute inset-x-4 bottom-20 rounded-md bg-red-600/90 px-3 py-2 text-center text-sm">
                {repairScan.error}
              </div>
            )}
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-white/10 bg-black/80 px-4 py-3">
            <p className="text-xs text-white/60">
              Point at the QR shown on the terminal.
            </p>
            <Button variant="ghost" size="sm" onClick={() => setRepairScanOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      );
    }
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-6">
        <Alert variant="destructive" className="max-w-sm">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Pairing failed</AlertTitle>
          <AlertDescription>
            {error || "Pairing token is invalid or expired."}
            <div className="mt-3 flex flex-col gap-2">
              <Button size="sm" onClick={() => setRepairScanOpen(true)}>
                <Camera className="mr-1 h-3 w-3" /> Scan new QR code
              </Button>
              <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
                <RefreshCw className="mr-1 h-3 w-3" /> Try again
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      </div>
    );
  }


  if (status === "loading" || !claim) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-2">
          <Loader2 className="h-6 w-6 animate-spin" />
          <span className="text-sm text-muted-foreground">Pairing with terminal…</span>
        </div>
      </div>
    );
  }

  // -------- Cockpit helpers --------
  const contactAgo = lastContactAgo ?? 0;
  const healthMeta: Record<ScannerHealth, { label: string; dot: string; ring: string; text: string }> = {
    ok:       { label: "Connected",     dot: "bg-emerald-400", ring: "ring-emerald-400/40", text: "text-emerald-300" },
    degraded: { label: "Reconnecting",  dot: "bg-amber-400 animate-pulse", ring: "ring-amber-400/40", text: "text-amber-200" },
    down:     { label: "Offline",       dot: "bg-red-500",     ring: "ring-red-500/40",     text: "text-red-300" },
    revoked:  { label: "Disconnected",  dot: "bg-red-500",     ring: "ring-red-500/40",     text: "text-red-300" },
  };
  const hm = healthMeta[health];

  const workflowMeta: Record<AckWorkflow, { icon: typeof Tag; label: string }> = {
    identity: { icon: Tag,          label: "Identity" },
    quantity: { icon: Hash,         label: "Quantity" },
    count:    { icon: ClipboardList,label: "Count"    },
    receive:  { icon: PackageCheck, label: "Receive"  },
  };
  const wfKey = workflowChip?.workflow ?? null;
  const wfMeta = wfKey ? workflowMeta[wfKey] : null;
  const wfLabel = (workflowChip?.label || "").slice(0, 120);

  const revokeReasonCopy: Record<RevokeReason, string> = {
    manual:            "The terminal ended this pairing.",
    business_changed:  "You switched companies — pair again on the new workspace.",
    branch_changed:    "You switched branches — pair again on the new branch.",
    expired:           "The pairing expired. Pair again to keep scanning.",
    session_replaced:  "Another phone took over this session.",
  };

  // Repair-overlay state/hooks were hoisted above the early returns
  // (see block before the render branches) to keep hook order stable.


  return (
    <div className="flex h-[100dvh] flex-col bg-black text-white">
      <PhoneShortcutsOverlay
        onReconnect={handleManualReconnect}
        onToggleMute={() => feedbackTones.toggleMuted()}
        onToggleManual={() => setManualOpen((v) => !v)}
      />
      {/* === STATUS BAND (sticky 56-64px) === */}
      <header className="flex flex-col gap-1.5 border-b border-white/10 bg-black/80 px-4 py-2.5 backdrop-blur">
       <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[10px] uppercase tracking-wider text-white/50">Paired with</div>
          <div className="truncate text-sm font-semibold leading-tight">{claim.register_name}</div>
          <div
            className={cn(
              "mt-1 inline-flex max-w-full items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] ring-1",
              wfMeta
                ? "bg-emerald-500/10 ring-emerald-400/30 text-emerald-200"
                : "bg-white/5 ring-white/10 text-white/40",
            )}
            aria-live="polite"
          >
            {wfMeta ? (
              <>
                <wfMeta.icon className="h-3 w-3" />
                <span className="font-medium">{wfMeta.label}</span>
                {wfLabel && <span className="truncate text-white/70">· {wfLabel}</span>}
              </>
            ) : (
              <>
                <Tag className="h-3 w-3" />
                <span>Idle target</span>
              </>
            )}
          </div>
        </div>
        <div
          className={cn(
            "flex shrink-0 items-center gap-2 rounded-full bg-white/5 px-2.5 py-1 ring-1",
            hm.ring,
          )}
          aria-live="polite"
        >
          <span className={cn("h-2 w-2 rounded-full", hm.dot)} />
          <span className={cn("text-xs font-medium", hm.text)}>{hm.label}</span>
          {health === "ok" && (
            <span className="text-[10px] tabular-nums text-white/40">·&nbsp;{contactAgo}s</span>
          )}
          {queueDepth > 0 && (
            <span
              className="ml-1 rounded-full bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-medium text-amber-200 ring-1 ring-amber-400/30"
              title="Scans captured while offline — will send on reconnect"
            >
              queue&nbsp;{queueDepth}
            </span>
          )}
        </div>
       </div>
       {/* === METRICS ROW (uptime · spm · latency · reconnect) === */}
       <div className="flex items-center justify-between gap-2 text-[10px]">
         <div className="flex items-center gap-3 text-white/50">
           <span className="inline-flex items-center gap-1 tabular-nums" title="Session uptime">
             <Timer className="h-3 w-3" />
             {cockpit.uptimeLabel}
           </span>
           <span className="inline-flex items-center gap-1 tabular-nums" title="Scans in the last minute">
             <Gauge className="h-3 w-3" />
             {cockpit.scansLastMin}/min
           </span>
            <span className="inline-flex items-center gap-1 tabular-nums" title="Median ACK latency">
              <Zap className="h-3 w-3" />
              {cockpit.medianLatencyMs == null ? "—" : `${cockpit.medianLatencyMs}ms`}
            </span>
            {battery && (() => {
              const pct = Math.round(battery.level * 100);
              const Icon = battery.charging ? BatteryCharging
                : pct >= 60 ? BatteryFull
                : pct >= 30 ? BatteryMedium
                : BatteryLow;
              const tone = battery.charging
                ? "text-emerald-300"
                : pct < 15 ? "text-red-300"
                : pct < 30 ? "text-amber-200"
                : "text-white/50";
              return (
                <span
                  className={cn("inline-flex items-center gap-1 tabular-nums", tone)}
                  title={battery.charging ? `Battery ${pct}% — charging` : `Battery ${pct}%`}
                  aria-label={battery.charging ? `Battery ${pct}% charging` : `Battery ${pct}%`}
                >
                  <Icon className="h-3 w-3" />
                  {pct}%
                </span>
              );
            })()}
           {native.capability.vendor && (
             <button
               type="button"
               onClick={() => setUseDeviceScanner((v) => !v)}
               className={cn(
                 "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 transition",
                 native.active
                   ? "bg-emerald-500/15 text-emerald-200 ring-emerald-400/30 hover:bg-emerald-500/25"
                   : "bg-white/5 text-white/50 ring-white/10 hover:bg-white/10",
               )}
               title={native.active
                 ? `Hardware trigger active — ${native.capability.label}. Tap to disable.`
                 : `${native.capability.label} detected but disabled. Tap to enable.`}
             >
               <Zap className="h-3 w-3" />
               {native.active ? native.capability.label : "Use device scanner"}
             </button>
           )}
         </div>
         {health !== "ok" && health !== "revoked" && (
           <button
             type="button"
             onClick={handleManualReconnect}
             disabled={reconnectDisabled}
             className={cn(
               "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 transition",
               reconnectDisabled
                 ? "bg-white/5 text-white/40 ring-white/10"
                 : "bg-amber-500/15 text-amber-200 ring-amber-400/30 hover:bg-amber-500/25",
             )}
             aria-label="Reconnect now"
           >
             <RefreshCw className={cn("h-3 w-3", channelState === "reconnecting" && "animate-spin")} />
             {channelState === "reconnecting" && reconnectCountdownS > 0
               ? `Retrying in ${reconnectCountdownS}s`
               : "Reconnect now"}
           </button>
         )}
       </div>
      </header>

      {/* === SCAN AREA === */}
      <div className="relative flex-1 overflow-hidden bg-black">
        <video ref={videoRef} playsInline muted className="h-full w-full object-cover" />

        {/* Reticule */}
        {status === "scanning" && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="relative h-1/3 w-3/4 max-w-md rounded-xl border-2 border-emerald-400/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.45)]">
              {/* Corner accents */}
              {(["tl","tr","bl","br"] as const).map((c) => (
                <span
                  key={c}
                  className={cn(
                    "absolute h-5 w-5 border-emerald-300",
                    c === "tl" && "left-0 top-0 border-l-4 border-t-4 rounded-tl-xl",
                    c === "tr" && "right-0 top-0 border-r-4 border-t-4 rounded-tr-xl",
                    c === "bl" && "left-0 bottom-0 border-l-4 border-b-4 rounded-bl-xl",
                    c === "br" && "right-0 bottom-0 border-r-4 border-b-4 rounded-br-xl",
                  )}
                />
              ))}
            </div>
          </div>
        )}

        {/* Idle: thumb-reach Start, large icon */}
        {status === "ready" && channelState !== "revoked" && (
          <div className="absolute inset-0 flex flex-col items-center justify-end gap-6 p-6 pb-24 text-center">
            <Camera className="h-14 w-14 text-white/70" />
            <div>
              <div className="text-lg font-semibold">Ready to scan</div>
              <p className="mt-1 text-sm text-white/60">Aim the camera at a barcode.</p>
            </div>
            <Button size="lg" className="h-14 w-full max-w-xs rounded-2xl text-base" onClick={startCamera}>
              <Camera className="mr-2 h-5 w-5" /> Start camera
            </Button>
          </div>
        )}

        {/* Large persistent ACK band — full width, 2s, color = verdict */}
        {ackToast && (
          <div
            className={cn(
              "absolute inset-x-0 top-0 z-10 flex items-center justify-center gap-2 px-4 py-3 text-base font-semibold shadow-lg animate-in slide-in-from-top",
              (ackToast.kind === "ok" || ackToast.kind === "weighted")
                ? "bg-emerald-600/95 text-white"
                : ackToast.kind === "unknown"
                  ? "bg-amber-500/95 text-black"
                  : "bg-red-600/95 text-white",
            )}
            role="status"
          >
            {(ackToast.kind === "ok" || ackToast.kind === "weighted") ? (
              <CheckCircle2 className="h-5 w-5" />
            ) : ackToast.kind === "unknown" ? (
              <AlertTriangle className="h-5 w-5" />
            ) : (
              <XCircle className="h-5 w-5" />
            )}
            <span className="truncate font-mono">{ackToast.detail || ackToast.code}</span>
          </div>
        )}

        {/* Subtle in-flight chip when no ACK yet */}
        {lastScan && !ackToast && status === "scanning" && (
          <div className="absolute left-1/2 top-3 z-0 -translate-x-1/2 rounded-full bg-black/70 px-3 py-1 text-xs font-mono text-white/80 ring-1 ring-white/10">
            sent · {lastScan.code}
          </div>
        )}

        {/* Disconnected / revoked overlay — in-app QR rescan */}
        {showRepairOverlay && (
          <div className="absolute inset-0 z-20 flex flex-col bg-black/95 text-white">
            {repairScanOpen ? (
              <>
                <div className="relative flex-1 overflow-hidden bg-black">
                  <video
                    ref={repairVideoRef}
                    playsInline
                    muted
                    className="h-full w-full object-cover"
                  />
                  {/* QR reticule */}
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                    <div className="relative h-56 w-56 rounded-2xl border-2 border-sky-400/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.55)]" />
                  </div>
                  <div className="absolute inset-x-0 top-3 z-10 mx-auto w-fit rounded-full bg-sky-500/90 px-3 py-1 text-xs font-semibold">
                    Scan the new pairing QR
                  </div>
                  {repairScan.error && (
                    <div className="absolute inset-x-4 bottom-20 rounded-md bg-red-600/90 px-3 py-2 text-center text-sm">
                      {repairScan.error}
                    </div>
                  )}
                </div>
                <div className="flex items-center justify-between gap-3 border-t border-white/10 bg-black/80 px-4 py-3">
                  <p className="text-xs text-white/60">
                    Point at the QR shown on the terminal.
                  </p>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setRepairScanOpen(false)}
                  >
                    Cancel
                  </Button>
                </div>
              </>
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
                <Ban className="h-14 w-14 text-red-400" />
                <div>
                  <div className="text-lg font-semibold">
                    {channelState === "revoked" ? "Disconnected" : "Connection lost"}
                  </div>
                  <p className="mt-1 text-sm text-white/60">
                    {channelState === "revoked"
                      ? revokeReasonCopy[revokeReason ?? "manual"]
                      : "We haven't heard from the terminal in a while. Pair again to keep scanning."}
                  </p>
                </div>
                <div className="flex flex-col gap-2">
                  <Button onClick={handleRepair} className="w-60">
                    <Camera className="mr-2 h-4 w-4" /> Scan new QR
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleManualReconnect}
                    disabled={reconnectDisabled}
                  >
                    <RefreshCw className="mr-2 h-3 w-3" /> Retry current pairing
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* === RECENT-SCANS RAIL (collapsible) === */}
      <section className="border-t border-white/10 bg-black/90">
        <button
          type="button"
          onClick={() => setHistoryOpen((v) => !v)}
          className="flex w-full items-center justify-between px-4 py-2 text-xs text-white/70"
          aria-expanded={historyOpen}
        >
          <span className="flex items-center gap-2">
            <Activity className="h-3.5 w-3.5" />
            Recent scans
            <span className="ml-1 rounded-full bg-white/10 px-1.5 py-0.5 font-mono text-[10px] text-white/80">
              {scanCount}
            </span>
          </span>
          {historyOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}
        </button>
        {historyOpen && (
          <ul className="max-h-48 overflow-y-auto border-t border-white/5 px-2 pb-2">
            {recent.length > 0 && (
              <li className="flex items-center justify-between gap-2 px-1 pt-1">
                <div className="flex items-center gap-1">
                  {(["all", "errors", "unknown"] as const).map((f) => (
                    <button
                      key={f}
                      type="button"
                      onClick={() => setRecentFilter(f)}
                      className={cn(
                        "rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wider transition",
                        recentFilter === f
                          ? "bg-white/15 text-white"
                          : "text-white/40 hover:text-white/70",
                      )}
                    >
                      {f}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => setRecent([])}
                  className="rounded px-2 py-0.5 text-[10px] uppercase tracking-wider text-white/50 hover:bg-white/5 hover:text-white/80"
                  aria-label="Clear recent scans"
                >
                  Clear
                </button>
              </li>
            )}
            {recent.length === 0 && (
              <li className="px-2 py-3 text-center text-xs text-white/40">No scans yet.</li>
            )}
            {recent
              .filter((r) => {
                if (recentFilter === "all") return true;
                if (recentFilter === "errors") return r.kind === "error";
                if (recentFilter === "unknown") return r.kind === "unknown";
                return true;
              })
              .map((r) => (
              <li
                key={r.id}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-white/5"
              >
                {r.kind === "pending" && <Loader2 className="h-3.5 w-3.5 animate-spin text-white/50" />}
                {(r.kind === "ok" || r.kind === "weighted") && (
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                )}
                {r.kind === "unknown" && <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />}
                {r.kind === "error" && <XCircle className="h-3.5 w-3.5 text-red-400" />}
                <span className="flex flex-1 items-center gap-1.5 truncate">
                  {r.symbology && (
                    <span className="rounded bg-white/10 px-1 py-0.5 text-[9px] font-medium uppercase tracking-wider text-white/60">
                      {r.symbology}
                    </span>
                  )}
                  <span className="truncate font-mono text-xs text-white/90">{r.detail || r.code}</span>
                </span>
                {r.kind !== "pending" && (
                  <button
                    type="button"
                    onClick={() => broadcastScan(r.code)}
                    className="rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-white/40 hover:bg-white/10 hover:text-white/90"
                    title="Rescan this code"
                    aria-label={`Rescan ${r.code}`}
                  >
                    Rescan
                  </button>
                )}
                <span className="text-[10px] tabular-nums text-white/40">
                  {Math.max(0, Math.floor((Date.now() - r.at) / 1000))}s
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* === ACTION DOCK (thumb-reach) === */}
      <footer className="border-t border-white/10 bg-black px-4 pb-[max(env(safe-area-inset-bottom),0.75rem)] pt-3">
        <div className="flex items-center gap-2">
          {status === "scanning" ? (
            <Button
              variant="destructive"
              className="h-12 flex-1 rounded-xl"
              onClick={stopCamera}
            >
              <CameraOff className="mr-2 h-4 w-4" /> Stop
            </Button>
          ) : (
            <Button
              className="h-12 flex-1 rounded-xl"
              onClick={startCamera}
              disabled={channelState === "revoked"}
            >
              <Camera className="mr-2 h-4 w-4" /> Start
            </Button>
          )}

          <Button
            variant="outline"
            size="icon"
            className={cn(
              "h-12 w-12 rounded-xl border-white/20 bg-white/5 text-white hover:bg-white/10",
              torchOn && "bg-amber-400/20 border-amber-300/50 text-amber-200",
            )}
            disabled={status !== "scanning"}
            onClick={toggleTorch}
            aria-label="Torch"
            aria-pressed={torchOn}
          >
            <Flashlight className="h-5 w-5" />
          </Button>

          <Button
            variant="outline"
            size="icon"
            className={cn(
              "h-12 w-12 rounded-xl border-white/20 bg-white/5 text-white hover:bg-white/10",
              manualOpen && "bg-white/10",
            )}
            onClick={() => setManualOpen((v) => !v)}
            aria-label="Manual entry"
            aria-pressed={manualOpen}
          >
            <Keyboard className="h-5 w-5" />
          </Button>

          <Button
            variant="outline"
            size="icon"
            className={cn(
              "h-12 w-12 rounded-xl border-white/20 bg-white/5 text-white hover:bg-white/10",
              muted && "bg-white/10 text-white/50",
            )}
            onClick={() => feedbackTones.toggleMuted()}
            aria-label={muted ? "Unmute scanner sounds" : "Mute scanner sounds"}
            aria-pressed={muted}
          >
            {muted ? <VolumeX className="h-5 w-5" /> : <Volume2 className="h-5 w-5" />}
          </Button>
        </div>

        {manualOpen && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!manualCode.trim()) return;
              broadcastScan(manualCode);
              setManualCode("");
            }}
            className="mt-2 flex gap-2"
          >
            <Input
              autoFocus
              value={manualCode}
              onChange={(e) => setManualCode(e.target.value)}
              placeholder="Type barcode and press Send"
              inputMode="numeric"
              autoComplete="off"
              className="h-11 border-white/20 bg-white/10 text-white placeholder:text-white/40"
            />
            <Button type="submit" className="h-11">Send</Button>
          </form>
        )}
      </footer>
    </div>
  );
}