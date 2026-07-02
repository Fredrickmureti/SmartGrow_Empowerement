/**
 * useScanChannel — generalized desk-side subscriber for ANY scan
 * channel topic (`pos:scan:<id>` OR `scan:session:<id>`).
 *
 * Mirrors `usePOSScannerChannel` but accepts an arbitrary topic so the
 * Products page, inventory receiving, and other onboarding workflows can
 * subscribe to their own per-session channels without going through a POS
 * register.
 *
 * Emits incoming scans onto the in-process `scanBus`, where the
 * `scanRouter` then routes them to the focused field.
 *
 * S5 telemetry: tracks last-scan timestamp, last-pong timestamp, and a
 * rolling RTT median (samples = 10) populated by `pingPhone()`. Used by
 * `ScannerSessionDialog` to surface operational state to the desk.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { scanBus } from "@/services/pos/scanBus";
import { scanFeedbackBus, type ScanFeedback } from "@/services/pos/scanFeedbackBus";
import { sendScanEvent } from "@/services/scanner/scanEventTelemetry";
import {
  drainAckOutbox,
  enqueueAck,
  type AckOutboxState,
  type OutboxAck,
} from "@/services/scanner/ackOutbox";
import {
  SCAN_EVENTS,
  safeParsePong,
  type RevokeReason,
} from "@/services/scanner/ackPayload";

export interface ConnectedScannerDevice {
  user_id: string;
  device_label: string;
  online_at: string;
}

interface IncomingScan {
  code: string;
  quantity?: number;
  seq?: number;
  decoded_at?: number;
  device_id?: string;
}

interface Options {
  /** Full Realtime topic, e.g. `scan:session:<uuid>`. Empty disables. */
  topic: string | null | undefined;
  /** Called to revoke pairings server-side when the user clicks Disconnect. */
  onRevoke?: () => Promise<{ ok: boolean; count: number; error?: string }>;
}

const RTT_WINDOW = 10;
const PING_TIMEOUT_MS = 1500;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function useScanChannel({ topic, onRevoke }: Options) {
  const [connectedDevices, setConnectedDevices] = useState<ConnectedScannerDevice[]>([]);
  const [lastScanAt, setLastScanAt] = useState<number | null>(null);
  const [rttSamples, setRttSamples] = useState<number[]>([]);
  /** Per-device "last successful scan" timestamps (post-dedupe, throttled). */
  const [lastScanByDevice, setLastScanByDevice] = useState<Record<string, number>>({});
  const lastScanByDeviceRef = useRef<Record<string, number>>({});
  const lastScanCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSeqRef = useRef<Map<string, number>>(new Map());
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const lastAckedRef = useRef<{ code: string; at: number } | null>(null);
  /** Most-recent scan metadata keyed by code, used to enrich telemetry. */
  const lastScanMetaRef = useRef<Map<string, { deviceId: string; seq: number; decodedAt: number }>>(new Map());
  const pingIdSeqRef = useRef(0);
  const pendingPingsRef = useRef<Map<string, number>>(new Map());
  /**
   * Outbound ACK ring buffer. When the desk loses realtime mid-burst,
   * verdicts (and their paired telemetry rows) would otherwise be lost.
   * `ackOutbox` enforces FIFO + cap-100 + dedupe; drained on SUBSCRIBED.
   * Pure helper unit-tested in `src/test/scanner/ack-outbox.test.ts`.
   */
  const ackOutboxRef = useRef<OutboxAck[]>([]);
  const ackOutboxStateRef = useRef<AckOutboxState>({ fullNoticeShown: false });
  const [channelReady, setChannelReady] = useState(false);

  useEffect(() => {
    if (!topic) return;
    const channel = supabase.channel(topic, {
      config: {
        broadcast: { ack: false, self: false },
        presence: { key: "" },
        private: true,
      } as any,
    });
    channelRef.current = channel;

    channel
      .on("broadcast", { event: SCAN_EVENTS.scan }, ({ payload }) => {
        const p = (payload || {}) as IncomingScan & { scan_id?: string };
        if (!p.code || typeof p.code !== "string") return;
        if (p.device_id && typeof p.seq === "number") {
          const prev = lastSeqRef.current.get(p.device_id) ?? -1;
          if (p.seq <= prev) return;
          lastSeqRef.current.set(p.device_id, p.seq);
        }
        if (p.device_id) {
          lastScanByDeviceRef.current = {
            ...lastScanByDeviceRef.current,
            [p.device_id]: Date.now(),
          };
          if (!lastScanCommitTimerRef.current) {
            lastScanCommitTimerRef.current = setTimeout(() => {
              lastScanCommitTimerRef.current = null;
              setLastScanByDevice(lastScanByDeviceRef.current);
            }, 250);
          }
        }
        const scanId = p.scan_id
          ?? (p.device_id && typeof p.seq === "number" ? `${p.device_id}|${p.seq}` : undefined);
        setLastScanAt(Date.now());
        const normCode = p.code.trim();
        lastScanMetaRef.current.set(normCode, {
          deviceId: p.device_id ?? "unknown",
          seq: typeof p.seq === "number" ? p.seq : 0,
          decodedAt: typeof p.decoded_at === "number" ? p.decoded_at : Date.now(),
        });
        scanBus.emit({
          raw: p.code,
          code: normCode,
          quantity: Math.max(1, Number(p.quantity) || 1),
          at: Date.now(),
          source: "camera",
          scanId,
          sourceTopic: topic ?? undefined,
          decodedAt: typeof p.decoded_at === "number" ? p.decoded_at : undefined,
        });
      })
      .on("broadcast", { event: SCAN_EVENTS.pong }, ({ payload }) => {
        // INVARIANT: pong updates RTT samples ONLY. It must NOT advance
        // `lastScanAt` — that field measures real scan activity for the
        // desk-side telemetry pill and must not be inflated by heartbeats.
        const parsed = safeParsePong(payload);
        if (!parsed) return;
        const sentAt = pendingPingsRef.current.get(parsed.id);
        if (sentAt === undefined) return;
        pendingPingsRef.current.delete(parsed.id);
        const rtt = Date.now() - sentAt;
        setRttSamples((prev) => {
          const next = [...prev, rtt];
          if (next.length > RTT_WINDOW) next.shift();
          return next;
        });
      })
      .on("presence", { event: "sync" }, () => {
        const state = channel.presenceState() as Record<string, ConnectedScannerDevice[]>;
        const flat: ConnectedScannerDevice[] = [];
        for (const arr of Object.values(state)) for (const meta of arr) flat.push(meta);
        setConnectedDevices(flat);
      })
      .subscribe((state) => {
        if (state === "SUBSCRIBED") {
          setChannelReady(true);
          const drained = drainAckOutbox(ackOutboxRef.current, ackOutboxStateRef.current);
          for (const ack of drained) {
            void channel.send({
              type: "broadcast",
              event: SCAN_EVENTS.ack,
              payload: ack,
            });
          }
        } else if (state === "CHANNEL_ERROR" || state === "CLOSED" || state === "TIMED_OUT") {
          setChannelReady(false);
        }
      });

    return () => {
      supabase.removeChannel(channel);
      channelRef.current = null;
      setChannelReady(false);
      lastSeqRef.current.clear();
      pendingPingsRef.current.clear();
      setConnectedDevices([]);
      if (lastScanCommitTimerRef.current) {
        clearTimeout(lastScanCommitTimerRef.current);
        lastScanCommitTimerRef.current = null;
      }
      lastScanByDeviceRef.current = {};
      setLastScanByDevice({});
    };
  }, [topic]);

  // Mirror local feedback as ACK to the phone, with workflow/field_label.
  // Also fire a sampled `log_scan_event` so we get a server-side audit
  // trail for p95 latency + per-workflow unknown-rate. The RPC is
  // SECURITY DEFINER with its own rate limit; never throws into the UI.
  useEffect(() => {
    if (!topic) return;
    // Topic shape is `scan:session:<uuid>` for non-POS sessions.
    const sessionId = topic.startsWith("scan:session:") ? topic.slice("scan:session:".length) : null;
    const unsub = scanFeedbackBus.on((fb: ScanFeedback) => {
      const ch = channelRef.current;
      if (!ch) return;
      if (fb.kind === "pending") return;
      const code = (fb.raw || "").trim();
      if (!code) return;
      const now = Date.now();
      const last = lastAckedRef.current;
      if (last && last.code === code && now - last.at < 400) return;
      lastAckedRef.current = { code, at: now };
      const meta = lastScanMetaRef.current.get(code);
      const ackPayload: OutboxAck = {
        code,
        seq: meta?.seq ?? 0,
        kind: fb.kind,
        detail: fb.detail ?? null,
        at: now,
        workflow: fb.workflow ?? null,
        field_label: fb.fieldLabel ?? null,
      };
      if (channelReady) {
        void ch.send({
          type: "broadcast",
          event: SCAN_EVENTS.ack,
          payload: ackPayload,
        });
      } else {
        // Channel is reconnecting — buffer so the cockpit verdict survives.
        enqueueAck(ackOutboxRef.current, ackPayload, ackOutboxStateRef.current);
      }
      // Fire-and-forget telemetry — see migration `log_scan_event`.
      // Insert is gated by RLS + per-device 30/min rate limit.
      if (sessionId) {
        const sourceTag: "camera" | "manual" | "wedge" | "phone" =
          fb.source === "field" ? "manual" : "phone";
        void sendScanEvent({
          sessionId,
          deviceId: meta?.deviceId ?? "desk",
          code,
          seq: meta?.seq ?? 0,
          decodedAt: meta?.decodedAt ?? now,
          verdict: fb.kind,
          workflow: fb.workflow ?? null,
          source: sourceTag,
        });
      }
    });
    return unsub;
  }, [topic, channelReady]);

  const revoke = useCallback(async (reason: RevokeReason = "manual") => {
    if (!onRevoke) return { ok: false, count: 0, error: "no revoke handler" };
    const result = await onRevoke();
    const ch = channelRef.current;
    if (ch && result.ok) {
      void ch.send({
        type: "broadcast",
        event: SCAN_EVENTS.revoke,
        payload: { at: Date.now(), reason },
      });
    }
    return result;
  }, [onRevoke]);

  /** Round-trip a heartbeat; resolves with RTT in ms or null on timeout. */
  const pingPhone = useCallback(async (): Promise<number | null> => {
    const ch = channelRef.current;
    if (!ch) return null;
    const id = `ping-${++pingIdSeqRef.current}-${Date.now()}`;
    const sentAt = Date.now();
    pendingPingsRef.current.set(id, sentAt);
    void ch.send({
      type: "broadcast",
      event: SCAN_EVENTS.ping,
      payload: { id, at: sentAt },
    });
    return new Promise((resolve) => {
      const startSize = rttSamples.length;
      const timer = setTimeout(() => {
        pendingPingsRef.current.delete(id);
        resolve(null);
      }, PING_TIMEOUT_MS);
      // Poll the samples ref (cheap; max ~15 iterations).
      const poll = setInterval(() => {
        if (!pendingPingsRef.current.has(id)) {
          clearTimeout(timer);
          clearInterval(poll);
          // The pong handler appended a sample; read the latest.
          // We can't read state directly here, so re-resolve with the
          // RTT we computed from now - sentAt (idempotent).
          resolve(Date.now() - sentAt);
        }
      }, 50);
      // Reference startSize so eslint stays quiet about unused vars.
      void startSize;
    });
  }, [rttSamples.length]);

  const rttMedianMs = median(rttSamples);

  return { connectedDevices, revoke, pingPhone, lastScanAt, rttMedianMs, lastScanByDevice };
}
