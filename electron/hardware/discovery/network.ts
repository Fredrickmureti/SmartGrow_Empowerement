/**
 * Network discovery — main process.
 *
 * Audit Wave 9d.8 (P2 #11). mDNS/Bonjour browsing now lands behind a
 * lazy import of `bonjour-service`. If the package isn't available
 * (development sandboxes, hardened deployments) discovery falls back
 * to the previous "manual only" behaviour without crashing.
 *
 * Service types browsed:
 *   - `_ipp._tcp`              (Internet Printing Protocol — most office printers)
 *   - `_pdl-datastream._tcp`   (raw 9100, advertised by Zebra/most receipt LANs)
 *   - `_printer._tcp`          (Line Printer Daemon legacy advertisement)
 *   - `_escpos._tcp`           (some Epson firmware)
 *   - `_uscan._tcp` / `_ipps._tcp` — read-only enumeration (filtered out for now)
 *
 * `probeHost(host, port)` keeps the manual reachability test for
 * operator-entered IP:port pairs (used by the "Test reachability"
 * button on the manual-add path).
 */

import { connect, type Socket } from 'net';
import { classifyNetwork, type ClassifiedCandidate } from './classify';

export interface NetworkCandidate {
  transport: 'network';
  host: string;
  port: number;
  name?: string | null;
  service?: string | null;
  txt?: Record<string, string>;
  classification?: ClassifiedCandidate;
}

export interface NetworkDiscoveryResult {
  candidates: NetworkCandidate[];
  notImplemented?: boolean;
  note?: string;
}

interface BonjourLike {
  default?: new () => BonjourLike;
  find: (opts: { type: string }, cb: (svc: BonjourService) => void) => { stop?: () => void };
  destroy?: () => void;
}
interface BonjourService {
  name?: string;
  type?: string;
  host?: string;
  addresses?: string[];
  port: number;
  txt?: Record<string, string>;
}

const SERVICE_TYPES = ['ipp', 'pdl-datastream', 'printer', 'escpos'];

async function loadBonjour(): Promise<BonjourLike | null> {
  try {
    const mod = (await import('bonjour-service' as never)) as unknown as { default?: new () => BonjourLike; Bonjour?: new () => BonjourLike };
    const Ctor = (mod.default ?? mod.Bonjour);
    if (!Ctor) return null;
    return new Ctor();
  } catch {
    return null;
  }
}

function pickAddress(svc: BonjourService): string | null {
  if (!svc.addresses || svc.addresses.length === 0) return svc.host ?? null;
  // Prefer IPv4 to keep raw-9100 transports happy.
  const v4 = svc.addresses.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a));
  return v4 ?? svc.addresses[0] ?? svc.host ?? null;
}

export async function discoverNetworkDevices(timeoutMs = 3500): Promise<NetworkDiscoveryResult> {
  const bonjour = await loadBonjour();
  if (!bonjour) {
    return {
      candidates: [],
      notImplemented: true,
      note: 'mDNS unavailable (bonjour-service not installed). Add devices manually with IP:port and use the reachability probe.',
    };
  }

  const seen = new Map<string, NetworkCandidate>();
  const browsers: Array<{ stop?: () => void }> = [];

  for (const type of SERVICE_TYPES) {
    try {
      const browser = bonjour.find({ type }, (svc) => {
        const host = pickAddress(svc);
        if (!host) return;
        const port = svc.port || 9100;
        const key = `${host}:${port}`;
        if (seen.has(key)) return;
        const cand: NetworkCandidate = {
          transport: 'network',
          host,
          port,
          name: svc.name ?? null,
          service: svc.type ?? type,
          txt: svc.txt,
          classification: classifyNetwork(host, port, svc.type ?? type, svc.txt),
        };
        seen.set(key, cand);
      });
      browsers.push(browser);
    } catch {
      /* skip this service type */
    }
  }

  await new Promise((r) => setTimeout(r, timeoutMs));
  for (const b of browsers) { try { b.stop?.(); } catch { /* noop */ } }
  try { bonjour.destroy?.(); } catch { /* noop */ }

  return { candidates: Array.from(seen.values()) };
}

export async function probeHost(host: string, port: number, timeoutMs = 1500): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    let socket: Socket | null = null;
    const finish = (r: { ok: boolean; latencyMs?: number; error?: string }) => {
      if (settled) return;
      settled = true;
      try { socket?.destroy(); } catch { /* noop */ }
      resolve(r);
    };
    try {
      socket = connect({ host, port });
      const timer = setTimeout(() => finish({ ok: false, error: `timeout after ${timeoutMs}ms` }), timeoutMs);
      socket.once('connect', () => { clearTimeout(timer); finish({ ok: true, latencyMs: Date.now() - started }); });
      socket.once('error', (err) => { clearTimeout(timer); finish({ ok: false, error: (err as Error).message }); });
    } catch (err) {
      finish({ ok: false, error: (err as Error).message });
    }
  });
}
