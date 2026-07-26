/**
 * Minimal Supabase Realtime client for the desktop shell.
 *
 * Phase 4.2 item 2 — replaces the 10-15s polls in Dashboard.tsx and
 * Devices.tsx with a live `postgres_changes` subscription.
 *
 * We deliberately do not import `@supabase/supabase-js` — this keeps the
 * installer surface small and matches the design of `lib/supabase.ts`.
 * The Phoenix v2 protocol Realtime uses is a stable JSON envelope over
 * WebSocket; a ~150-line client is enough for the two channels we need.
 *
 * Contract:
 *   subscribeTable({ table, filter, onChange }) → { close }
 *   - Falls back silently if the socket cannot open; callers should
 *     always keep a poll timer as a safety net (see Dashboard/Devices).
 */

import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config';
import { currentSession } from './supabase';

type Ref = number;
interface Envelope {
  topic: string;
  event: string;
  payload: Record<string, unknown>;
  ref?: Ref | null;
  join_ref?: Ref | null;
}

interface SubscribeOpts {
  schema?: string;
  table: string;
  event?: '*' | 'INSERT' | 'UPDATE' | 'DELETE';
  /** PostgREST-style filter, e.g. `id=eq.abc`. */
  filter?: string;
  onChange: (payload: {
    eventType: 'INSERT' | 'UPDATE' | 'DELETE';
    new: Record<string, unknown> | null;
    old: Record<string, unknown> | null;
  }) => void;
  onOpen?: () => void;
  onError?: (err: unknown) => void;
}

export interface Subscription { close(): void }

let socket: WebSocket | null = null;
let ref: Ref = 0;
const nextRef = (): Ref => ++ref;
const channels = new Map<string, { joinRef: Ref; opts: SubscribeOpts }>();
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

function socketUrl(): string {
  const base = SUPABASE_URL.replace(/^http/, 'ws');
  const token = currentSession()?.access_token ?? SUPABASE_ANON_KEY;
  return `${base}/realtime/v1/websocket?apikey=${encodeURIComponent(SUPABASE_ANON_KEY)}&vsn=1.0.0&token=${encodeURIComponent(token)}`;
}

function ensureSocket(): WebSocket {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return socket;
  }
  socket = new WebSocket(socketUrl());
  socket.onopen = () => {
    // Re-join any pre-existing channels after reconnect.
    for (const [topic, entry] of channels) sendJoin(topic, entry);
    if (!heartbeatTimer) {
      heartbeatTimer = setInterval(() => {
        try {
          socket?.send(JSON.stringify({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: nextRef() }));
        } catch { /* noop */ }
      }, 25_000);
    }
  };
  socket.onmessage = (ev) => {
    let msg: Envelope;
    try { msg = JSON.parse(String(ev.data)); } catch { return; }
    const entry = channels.get(msg.topic);
    if (!entry) return;
    if (msg.event === 'postgres_changes') {
      const rec = msg.payload as { data?: { type?: string; record?: unknown; old_record?: unknown } };
      const d = rec?.data;
      if (!d?.type) return;
      const type = d.type as 'INSERT' | 'UPDATE' | 'DELETE';
      entry.opts.onChange({
        eventType: type,
        new: (d.record ?? null) as Record<string, unknown> | null,
        old: (d.old_record ?? null) as Record<string, unknown> | null,
      });
    } else if (msg.event === 'phx_reply' && msg.payload?.status === 'ok' && msg.ref === entry.joinRef) {
      entry.opts.onOpen?.();
    } else if (msg.event === 'phx_error') {
      entry.opts.onError?.(msg.payload);
    }
  };
  socket.onerror = (err) => {
    for (const entry of channels.values()) entry.opts.onError?.(err);
  };
  socket.onclose = () => {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    // Reconnect with 3s backoff if any channels still want it.
    if (channels.size > 0) setTimeout(() => ensureSocket(), 3_000);
  };
  return socket;
}

function sendJoin(topic: string, entry: { joinRef: Ref; opts: SubscribeOpts }) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  const cfg: Record<string, unknown> = {
    schema: entry.opts.schema ?? 'public',
    table: entry.opts.table,
    event: entry.opts.event ?? '*',
  };
  if (entry.opts.filter) cfg.filter = entry.opts.filter;
  const payload = {
    config: {
      postgres_changes: [cfg],
      broadcast: { self: false, ack: false },
      presence: { key: '' },
    },
  };
  socket.send(JSON.stringify({ topic, event: 'phx_join', payload, ref: entry.joinRef, join_ref: entry.joinRef }));
}

let topicCounter = 0;

export function subscribeTable(opts: SubscribeOpts): Subscription {
  const topic = `realtime:public:${opts.table}:${++topicCounter}`;
  const joinRef = nextRef();
  channels.set(topic, { joinRef, opts });
  const sock = ensureSocket();
  if (sock.readyState === WebSocket.OPEN) sendJoin(topic, { joinRef, opts });
  return {
    close() {
      try {
        socket?.send(JSON.stringify({ topic, event: 'phx_leave', payload: {}, ref: nextRef(), join_ref: joinRef }));
      } catch { /* noop */ }
      channels.delete(topic);
      if (channels.size === 0 && socket) {
        try { socket.close(); } catch { /* noop */ }
        socket = null;
        if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
      }
    },
  };
}