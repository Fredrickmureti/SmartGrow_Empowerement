/**
 * payloadBytes — the single normaliser that turns a print payload into raw
 * bytes for a byte-oriented transport (local agent, WebUSB, relay).
 *
 * Extracted from `BrowserHardwareAdapter` in the execution-consolidation
 * pass so the assignment-keyed dispatch path and the legacy role-keyed
 * renderer adapter cannot drift on ZPL/EPL envelope handling.
 */
import { mediaDots } from '@/services/printing/mediaGeometry';

export interface MediaHints {
  mediaWidthMm?: number;
  mediaHeightMm?: number;
  dpi?: number;
}

/**
 * ADR-0087 — strip any `^PW`/`^LL` present in the body and re-emit them
 * from the resolved media so every transport scales content identically.
 */
export function injectZplEnvelope(zpl: string, p: MediaHints): string {
  const w = Number(p.mediaWidthMm);
  const h = Number(p.mediaHeightMm);
  if (!Number.isFinite(w) || !Number.isFinite(h)) return zpl;
  const { widthDots, heightDots } = mediaDots({ widthMm: w, heightMm: h, dpi: Number(p.dpi) || 203 });
  const stripped = zpl.replace(/\^PW\d+/g, '').replace(/\^LL\d+/g, '');
  const head = stripped.indexOf('^XA');
  if (head < 0) return `^XA\n^PW${widthDots}\n^LL${heightDots ?? widthDots}\n${stripped}\n^XZ`;
  const before = stripped.slice(0, head + 3);
  const after = stripped.slice(head + 3);
  return `${before}\n^PW${widthDots}\n^LL${heightDots ?? widthDots}${after.startsWith('\n') ? '' : '\n'}${after}`;
}

export function injectEplEnvelope(epl: string, p: MediaHints): string {
  const w = Number(p.mediaWidthMm);
  const h = Number(p.mediaHeightMm);
  if (!Number.isFinite(w) || !Number.isFinite(h)) return epl;
  const { widthDots, heightDots } = mediaDots({ widthMm: w, heightMm: h, dpi: Number(p.dpi) || 203 });
  const stripped = epl
    .replace(/^\s*q\d+\s*\r?\n/gm, '')
    .replace(/^\s*Q\d+,\d+(?:\+\d+)?\s*\r?\n/gm, '');
  return `q${widthDots}\r\nQ${heightDots ?? widthDots},24\r\n${stripped}`;
}

export type RawPayload =
  | number[]
  | Uint8Array
  | ({
      bytes?: number[] | Uint8Array;
      zpl?: string;
      epl?: string;
      text?: string;
    } & MediaHints)
  | undefined
  | null;

/**
 * Reduce a dispatch payload to a plain byte array, applying the label
 * envelope when the payload carries media hints. Returns `null` when the
 * payload carries no byte-producing field — callers must refuse rather
 * than send an empty job.
 */
export function toRawBytes(payload: unknown): number[] | null {
  const raw = payload as RawPayload;
  if (!raw) return null;
  if (raw instanceof Uint8Array) return Array.from(raw);
  if (Array.isArray(raw)) return raw.every((b) => typeof b === 'number') ? raw : null;
  if (typeof raw !== 'object') return null;

  if (raw.bytes instanceof Uint8Array) return Array.from(raw.bytes);
  if (Array.isArray(raw.bytes)) return raw.bytes;
  if (typeof raw.zpl === 'string') {
    return Array.from(new TextEncoder().encode(injectZplEnvelope(raw.zpl, raw)));
  }
  if (typeof raw.epl === 'string') {
    return Array.from(new TextEncoder().encode(injectEplEnvelope(raw.epl, raw)));
  }
  if (typeof raw.text === 'string') {
    return Array.from(new TextEncoder().encode(raw.text));
  }
  return null;
}