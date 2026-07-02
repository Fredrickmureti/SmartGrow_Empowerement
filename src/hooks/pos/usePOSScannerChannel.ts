/**
 * usePOSScannerChannel — terminal-side subscriber for the phone-as-scanner
 * realtime channel. Listens to `pos:scan:<register_id>` broadcast events
 * and re-emits each one onto the in-process scanBus with `source: 'camera'`,
 * so the terminal's existing resolve → cart pipeline handles it exactly
 * like a keyboard-wedge scan.
 *
 * Also tracks Realtime Presence so the UI can show a "Mobile scanner
 * connected" chip and which device is paired.
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
}

const RTT_WINDOW = 10;
const PING_TIMEOUT_MS = 1500;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function usePOSScannerChannel(registerId: string | undefined | null) {
  const [connectedDevices, setConnectedDevices] = useState<ConnectedScannerDevice[]>([]);
  const [lastScanAt, setLastScanAt] = useState<number | null>(null);
  const [rttSamples, setRttSamples] = useState<number[]>([]);
  /**
   * Per-device "last successful scan" timestamps. Only advanced INSIDE the
   * broadcast handler AFTER the seq dedupe guard, so pong heartbeats and
   * replayed duplicates never bump it (preserves the wave-3
   * `lastScanAt` pong-only-exclusion invariant). Throttled to ~4 Hz via
   * `lastScanCommitTimerRef` so a 60-scans-per-second burst doesn't
   * re-render the presence list on every event.
   */
  const [lastScanByDevice, setLastScanByDevice] = useState<Record<string, number>>({});
  const lastScanByDeviceRef = useRef<Record<string, number>>({});
  const lastScanCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSeqRef = useRef<Map<string, number>>(new Map());
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const lastAckedRef = useRef<{ code: string; at: number } | null>(null);
  /** Most-recent scan metadata keyed by code, for enriching telemetry. */
  const lastScanMetaRef = useRef<Map<string, { deviceId: string; seq: number; decodedAt: number }>>(new Map());
  const pingIdSeqRef = useRef(0);
  const pendingPingsRef = useRef<Map<string, number>>(new Map());
  /** Desk-side outbound ACK ring buffer — see ackOutbox. */
  const ackOutboxRef = useRef<OutboxAck[]>([]);
  const ackOutboxStateRef = useRef<AckOutboxState>({ fullNoticeShown: false });
  const [channelReady, setChannelReady] = useState(false);

  useEffect(() => {
    if (!registerId) return;
    const channelKey = `pos:scan:${registerId}`;
    // Private channel: realtime.messages RLS via can_access_pos_scan_channel(topic)
    const channel = supabase.channel(channelKey, {
      config: {
        broadcast: { ack: false, self: false },
        presence: { key: "" },
        private: true,
      } as any,
    });
    channelRef.current = channel;

    channel
      .on("broadcast", { event: SCAN_EVENTS.scan }, ({ payload }) => {
        const p = (payload || {}) as IncomingScan & { device_id?: string };
        if (!p.code || typeof p.code !== "string") return;
        // Per-device monotonic seq dedupe (was keyed on a literal "phone"
        // which collided across multiple paired phones).
        if (p.device_id && typeof p.seq === "number") {
          const prev = lastSeqRef.current.get(p.device_id) ?? -1;
          if (p.seq <= prev) return;
          lastSeqRef.current.set(p.device_id, p.seq);
        }
        // Per-device activity tracker (post-dedupe). Throttle commit.
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
        // Stable per-scan id. Prefer producer-supplied id; fall back to
        // a derived `device_id|seq` (already unique on the device).
        const scanId = (p as { scan_id?: string }).scan_id
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
          sourceTopic: channelKey,
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
        for (const arr of Object.values(state)) {
          for (const meta of arr) flat.push(meta);
        }
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
  }, [registerId]);

  // Mirror local scan-feedback events out as `ack` broadcasts so the phone
  // can give the cashier a red/green beep matching the terminal's verdict.
  useEffect(() => {
    if (!registerId) return;
    const unsub = scanFeedbackBus.on((fb: ScanFeedback) => {
      const ch = channelRef.current;
      if (!ch) return;
      // Don't ACK the cashier's own keyboard "pending" hint; it's noisy on
      // the phone. Only ACK terminal outcomes.
      if (fb.kind === "pending") return;
      // Skip non-terminal feedback (e.g. a BarcodeInputField on an
      // onboarding form). The phone is paired to this register, not to
      // that form, so mirroring those would beep for unrelated scans.
      if (fb.source && fb.source !== "terminal") return;
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
        enqueueAck(ackOutboxRef.current, ackPayload, ackOutboxStateRef.current);
      }
      // Telemetry — see migration `log_scan_event`. Fire-and-forget.
      void sendScanEvent({
        registerId,
        deviceId: meta?.deviceId ?? "desk",
        code,
        seq: meta?.seq ?? 0,
        decodedAt: meta?.decodedAt ?? now,
        verdict: fb.kind,
        workflow: fb.workflow ?? null,
        source: meta ? "phone" : "wedge",
      });
    });
    return unsub;
  }, [registerId, channelReady]);

  const revoke = useCallback(async (reason: RevokeReason = "manual") => {
    if (!registerId) return { ok: false, count: 0, error: "no register" };
    const { data, error } = await supabase.rpc(
      "pos_revoke_scanner_pairing" as any,
      { p_register_id: registerId } as any,
    );
    if (error) return { ok: false, count: 0, error: error.message };
    // Best-effort notify phone to stop the camera immediately.
    const ch = channelRef.current;
    if (ch) {
      void ch.send({
        type: "broadcast",
        event: SCAN_EVENTS.revoke,
        payload: { at: Date.now(), reason },
      });
    }
    return { ok: true, count: Number(data) || 0 };
  }, [registerId]);

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
      const timer = setTimeout(() => {
        pendingPingsRef.current.delete(id);
        resolve(null);
      }, PING_TIMEOUT_MS);
      const poll = setInterval(() => {
        if (!pendingPingsRef.current.has(id)) {
          clearTimeout(timer);
          clearInterval(poll);
          resolve(Date.now() - sentAt);
        }
      }, 50);
    });
  }, []);

  const rttMedianMs = median(rttSamples);

  return { connectedDevices, revoke, pingPhone, lastScanAt, rttMedianMs, lastScanByDevice };
}