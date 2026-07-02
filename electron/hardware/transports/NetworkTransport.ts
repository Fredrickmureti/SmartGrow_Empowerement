/**
 * NetworkTransport — main-process raw-TCP printer + agent-sidecar HMAC client.
 *
 * Two responsibilities:
 *   1. Raw TCP 9100 send for IP printers (ESC/POS over network).
 *   2. HMAC-signed POST to the optional `agent/` sidecar's `/print`
 *      endpoint when a tenant routes through a shared/network printer.
 *
 * The agent secret lives in OS keychain (keytar) in production; in tests
 * it is injected via the constructor. The signature scheme is:
 *   HMAC-SHA256(secret, `${timestamp}.${bodySha256}`)
 * Headers: `X-Lovable-Timestamp`, `X-Lovable-Signature`. Agent rejects
 * skew > 30 s and any mismatched body hash.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import * as nodenet from 'node:net';

export interface NetworkPrinterTarget {
  host: string;
  port: number;
  timeoutMs?: number;
}

export interface AgentTarget {
  baseUrl: string;
  secret: string;
  /** Optional fetch override for tests. */
  fetchImpl?: typeof fetch;
  /** Allowed clock skew on verification (seconds). */
  maxSkewSeconds?: number;
}

export class NetworkTransport {
  /** Open a TCP connection, write ESC/POS bytes, close. Returns bytes written. */
  static rawSend(target: NetworkPrinterTarget, bytes: Buffer | number[]): Promise<{ ok: true; bytes: number } | { ok: false; error: string }> {
    return new Promise(resolve => {
      const socket = new nodenet.Socket();
      const payload = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
      let settled = false;
      const finish = (r: { ok: true; bytes: number } | { ok: false; error: string }) => {
        if (settled) return;
        settled = true;
        try { socket.destroy(); } catch { /* noop */ }
        resolve(r);
      };
      socket.setTimeout(target.timeoutMs ?? 5_000, () => finish({ ok: false, error: 'timeout' }));
      socket.once('error', (err) => finish({ ok: false, error: err.message }));
      socket.connect(target.port, target.host, () => {
        socket.write(payload, (err) => {
          if (err) return finish({ ok: false, error: err.message });
          socket.end(() => finish({ ok: true, bytes: payload.length }));
        });
      });
    });
  }

  /**
   * Non-destructive liveness probe — TCP connect + immediate close.
   * Returns latency in ms on success. Used by DeviceManager's ping loop;
   * never writes data so it cannot accidentally trigger a print job.
   */
  static testConnect(target: NetworkPrinterTarget): Promise<{ ok: true; latencyMs: number } | { ok: false; error: string }> {
    return new Promise(resolve => {
      const socket = new nodenet.Socket();
      const started = Date.now();
      let settled = false;
      const finish = (r: { ok: true; latencyMs: number } | { ok: false; error: string }) => {
        if (settled) return;
        settled = true;
        try { socket.destroy(); } catch { /* noop */ }
        resolve(r);
      };
      socket.setTimeout(target.timeoutMs ?? 1_500, () => finish({ ok: false, error: 'timeout' }));
      socket.once('error', (err) => finish({ ok: false, error: err.message }));
      socket.connect(target.port, target.host, () => finish({ ok: true, latencyMs: Date.now() - started }));
    });
  }

  /** Sign + POST a print job to the agent sidecar. */
  static async sendToAgent(
    target: AgentTarget,
    path: string,
    body: unknown,
  ): Promise<{ ok: boolean; status: number; result?: unknown; error?: string }> {
    const raw = JSON.stringify(body ?? {});
    const ts = Math.floor(Date.now() / 1000).toString();
    const sig = NetworkTransport.sign(target.secret, ts, raw);
    const fetchImpl = target.fetchImpl ?? fetch;
    try {
      const res = await fetchImpl(`${target.baseUrl.replace(/\/$/, '')}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Lovable-Timestamp': ts,
          'X-Lovable-Signature': sig,
        },
        body: raw,
      });
      const text = await res.text();
      const parsed = text ? safeJsonParse(text) : null;
      return { ok: res.ok, status: res.status, result: parsed ?? text };
    } catch (err) {
      return { ok: false, status: 0, error: (err as Error).message };
    }
  }

  /** Stable signature: hex(HMAC-SHA256(secret, `${ts}.${sha256(body)}`)). */
  static sign(secret: string, timestamp: string, body: string): string {
    const bodyHash = createHash('sha256').update(body).digest('hex');
    return createHmac('sha256', secret).update(`${timestamp}.${bodyHash}`).digest('hex');
  }

  /** Constant-time verify with timestamp-skew enforcement. */
  static verify(
    secret: string,
    timestamp: string,
    body: string,
    signature: string,
    opts?: { now?: () => number; maxSkewSeconds?: number },
  ): { ok: true } | { ok: false; reason: string } {
    const skew = opts?.maxSkewSeconds ?? 30;
    const now = (opts?.now ?? (() => Math.floor(Date.now() / 1000)))();
    const tsNum = Number(timestamp);
    if (!Number.isFinite(tsNum)) return { ok: false, reason: 'invalid timestamp' };
    if (Math.abs(now - tsNum) > skew) return { ok: false, reason: 'timestamp skew exceeded' };
    const expected = NetworkTransport.sign(secret, timestamp, body);
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(signature || '', 'hex');
    if (a.length !== b.length) return { ok: false, reason: 'signature length mismatch' };
    return timingSafeEqual(a, b) ? { ok: true } : { ok: false, reason: 'signature mismatch' };
  }
}

function safeJsonParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}