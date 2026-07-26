/**
 * Identity presentation layer.
 *
 * Operators should never have to read a raw UUID. Every identifier that
 * reaches the UI is rendered as a short, typed, human-pronounceable
 * reference code (`WS-BEBAB9F5`) with the full value available on demand
 * (hover title + click-to-copy). The UUID stays the wire truth; the code
 * is what a person quotes on a support call.
 */

export type IdKind = 'workstation' | 'organization' | 'device' | 'job';

const PREFIX: Record<IdKind, string> = {
  workstation: 'WS',
  organization: 'ORG',
  device: 'DEV',
  job: 'JOB',
};

/** `bebab9f5-2786-…` → `WS-BEBAB9F5`. Stable, collision-safe enough for a desk. */
export function shortId(kind: IdKind, value?: string | null): string {
  if (!value) return '—';
  const compact = value.replace(/-/g, '');
  const head = compact.slice(0, 8).toUpperCase();
  return `${PREFIX[kind]}-${head || compact.toUpperCase()}`;
}

/** Two-letter monogram for the workstation avatar. */
export function monogram(name?: string | null): string {
  const words = (name ?? '').trim().split(/[\s_-]+/).filter(Boolean);
  if (words.length === 0) return 'WS';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

/** `label_printer` / `LABEL-PRINTER` → `Label printer`. */
export function humanize(value?: string | null): string {
  if (!value) return '—';
  const spaced = value.replace(/[_.-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

const ROLE_LABELS: Record<string, string> = {
  receipt_printer: 'Receipt printer',
  label_printer: 'Label printer',
  document_printer: 'Document printer',
  cash_drawer: 'Cash drawer',
  barcode_scanner: 'Barcode scanner',
  customer_display: 'Customer display',
  scale: 'Weighing scale',
  eft_terminal: 'Card terminal',
  biometric: 'Biometric reader',
};

export function roleLabel(role?: string | null): string {
  if (!role) return 'Unassigned';
  return ROLE_LABELS[role] ?? humanize(role);
}

const TRANSPORT_LABELS: Record<string, string> = {
  usb: 'USB',
  tcp: 'Network (TCP)',
  network: 'Network',
  serial: 'Serial',
  bluetooth: 'Bluetooth',
  loopback: 'Loopback',
};

export function transportLabel(t?: string | null): string {
  if (!t) return '—';
  return TRANSPORT_LABELS[t] ?? humanize(t);
}

/** "2 minutes ago" — relative time that degrades to an em dash. */
export function relativeTime(iso?: string | null): string {
  if (!iso) return 'Never';
  const diff = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(diff)) return '—';
  const s = Math.max(0, Math.round(diff / 1000));
  if (s < 10) return 'Just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr ago`;
  return `${Math.round(h / 24)} d ago`;
}

/** Compact absolute clock time, used as the secondary line under relative time. */
export function clockTime(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function uptimeLabel(seconds?: number | null): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${Math.floor(seconds % 60)}s`;
}